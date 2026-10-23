"""Transactional discovery frontier persistence, independent of finding rows.

Methods never commit: the worker owns the transaction that stores findings and
completes a path. Scan-row locking serializes admission and frontier closure.
"""

from psycopg.types.json import Jsonb

from .adaptive_discovery import discovery_config, discovery_step, path_key, validate_discovery

DISCOVERY_PATH_TABLE = "workflows.discovery_paths"
_RUNNABLE = {"prewarming_cache", "running"}
_TERMINAL_SCANS = {"stopped", "failed", "completed"}


def _remaining(frontier):
    return max(0.0, (frontier["deadline_at"] - frontier["observed_at"]).total_seconds())


class DiscoveryStore:
    """Mixin for Database; all writes require the caller's transaction."""

    def _discovery_lock(self, conn, scan_id, *, missing_ok=False):
        scan = conn.execute("SELECT * FROM public.scans WHERE id = %s FOR UPDATE", (scan_id,)).fetchone()
        if not scan:
            if missing_ok:
                return None, None
            raise ValueError("Discovery scan does not exist")
        frontier = conn.execute(
            "SELECT *, clock_timestamp() AS observed_at FROM workflows.discovery_frontiers "
            "WHERE scan_id = %s FOR UPDATE",
            (scan_id,),
        ).fetchone()
        return scan, frontier

    def lock_discovery(self, conn, scan_id):
        """Lock scan/frontier before native metadata writes in a final transaction."""
        _, frontier = self._discovery_lock(conn, scan_id)
        if frontier is None:
            raise ValueError("Discovery frontier is missing")
        return frontier

    def reconcile_existing_discovery(self, conn, scan_id):
        """Refresh existing history after native lifecycle changes; never seed a scan."""
        scan, frontier = self._discovery_lock(conn, scan_id, missing_ok=True)
        if frontier is None:
            return None
        return self._discovery_refresh(conn, frontier, scan_status=scan["status"])

    def reconcile_interrupted_discovery(self, conn):
        """Reconcile recorded active frontiers after native restart repair commits.

        The caller owns this transaction. Ordered scan locks avoid reversing the
        scan-before-metadata ordering used by native completion transactions.
        """
        rows = conn.execute(
            "SELECT scan_id FROM workflows.discovery_frontiers WHERE status = 'running' ORDER BY scan_id"
        ).fetchall()
        snapshots = []
        for row in rows:
            snapshot = self.reconcile_existing_discovery(conn, int(row["scan_id"]))
            if snapshot is not None:
                snapshots.append(snapshot)
        return snapshots

    def _discovery_paths(self, conn, scan_id):
        return conn.execute(
            """SELECT p.*, m.status AS metadata_status
               FROM workflows.discovery_paths p
               LEFT JOIN workflows.step_metadata m ON m.id = p.metadata_id
                 AND m.scan_id = p.scan_id AND m.step_id = p.step_id
                 AND m.prev_id = p.id AND m.prev_table = 'workflows.discovery_paths'
               WHERE p.scan_id = %s ORDER BY p.id FOR UPDATE OF p""",
            (scan_id,),
        ).fetchall()

    def _discovery_budget(self, conn, frontier, reason):
        conn.execute(
            "UPDATE workflows.discovery_frontiers SET budget_reason = coalesce(budget_reason, %s), "
            "updated_at = clock_timestamp() WHERE scan_id = %s",
            (reason, frontier["scan_id"]),
        )
        frontier["budget_reason"] = frontier.get("budget_reason") or reason

    def _discovery_refresh(self, conn, frontier, *, reconcile=True, scan_status=None):
        paths = self._discovery_paths(conn, frontier["scan_id"])
        for path in paths:
            if scan_status in _TERMINAL_SCANS and path["status"] == "pending":
                reason = "Native scan is " + str(scan_status) + "; path did not start"
                conn.execute(
                    "UPDATE workflows.discovery_paths SET status = 'blocked', reason = %s, "
                    "updated_at = clock_timestamp() WHERE id = %s AND scan_id = %s",
                    (reason, path["id"], frontier["scan_id"]),
                )
                path.update(status="blocked", reason=reason)
            if reconcile and path["status"] == "running" and path.get("metadata_status") != "running":
                reason = "Linked native attempt is " + str(path.get("metadata_status") or "missing")
                conn.execute(
                    "UPDATE workflows.discovery_paths SET status = 'blocked', reason = %s, "
                    "updated_at = clock_timestamp() WHERE id = %s AND scan_id = %s",
                    (reason, path["id"], frontier["scan_id"]),
                )
                path.update(status="blocked", reason=reason)
        active = any(path["status"] in {"pending", "running"} for path in paths)
        if active and _remaining(frontier) <= 0:
            self._discovery_budget(conn, frontier, "discovery_wall_time_reached")
            for path in paths:
                if path["status"] == "pending":
                    conn.execute(
                        "UPDATE workflows.discovery_paths SET status = 'budget_stopped', reason = %s, "
                        "updated_at = clock_timestamp() WHERE id = %s AND scan_id = %s",
                        (
                            "Discovery wall-time budget reached before this path started",
                            path["id"],
                            frontier["scan_id"],
                        ),
                    )
                    path.update(
                        status="budget_stopped", reason="Discovery wall-time budget reached before this path started"
                    )
        if any(path["status"] in {"pending", "running"} for path in paths):
            status, reason = "running", frontier.get("budget_reason")
        elif frontier.get("budget_reason") or any(path["status"] == "budget_stopped" for path in paths):
            status, reason = "budget_stopped", frontier.get("budget_reason") or "discovery_budget_reached"
        elif any(path["status"] == "blocked" for path in paths):
            status, reason = "blocked", "Recorded paths remain unresolved"
        else:
            status, reason = "exhausted", "All recorded paths completed; this is not exhaustive security coverage"
        conn.execute(
            "UPDATE workflows.discovery_frontiers SET status = %s, reason = %s, "
            "updated_at = clock_timestamp() WHERE scan_id = %s",
            (status, reason, frontier["scan_id"]),
        )
        return {
            **frontier,
            "status": status,
            "reason": reason,
            "paths": paths,
            "remaining_seconds": _remaining(frontier),
        }

    def discovery_snapshot(self, conn, scan, workflow):
        config = discovery_config(scan)
        if config is None:
            return None
        step = discovery_step(scan, workflow)
        current, frontier = self._discovery_lock(conn, int(scan["id"]))
        if discovery_config(current) != config:
            raise ValueError("Discovery configuration changed while scheduling")
        if frontier is None:
            if current["status"] not in _RUNNABLE:
                return None
            conn.execute(
                """INSERT INTO workflows.discovery_frontiers
                   (scan_id, workflow_id, step_id, max_paths, wall_time_seconds, deadline_at)
                   VALUES (%s, %s, %s, %s, %s, clock_timestamp() + make_interval(secs => %s))
                   ON CONFLICT (scan_id) DO NOTHING""",
                (
                    int(scan["id"]),
                    workflow.id,
                    step.id,
                    config["max_paths"],
                    config["wall_time_seconds"],
                    config["wall_time_seconds"],
                ),
            )
            scope = "."
            question = "Review the repository for security issues under the configured discovery instructions."
            conn.execute(
                """INSERT INTO workflows.discovery_paths
                   (scan_id, step_id, path_key, scope, question, rationale)
                   VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (scan_id, path_key) DO NOTHING""",
                (
                    int(scan["id"]),
                    step.id,
                    path_key(scope, question),
                    scope,
                    question,
                    "Initial discovery path from the configured workflow",
                ),
            )
            _, frontier = self._discovery_lock(conn, int(scan["id"]))
        if (
            int(frontier["workflow_id"]) != workflow.id
            or int(frontier["step_id"]) != step.id
            or frontier["max_paths"] != config["max_paths"]
            or frontier["wall_time_seconds"] != config["wall_time_seconds"]
        ):
            raise ValueError("Persisted discovery configuration differs from this scan")
        return self._discovery_refresh(conn, frontier, scan_status=current["status"])

    def claim_discovery_metadata(self, conn, **kwargs):
        if kwargs["prev_table"] != DISCOVERY_PATH_TABLE or kwargs["repeat_run"] != 1:
            raise ValueError("Invalid discovery job identity")
        scan_id, path_id = kwargs["scan_id"], kwargs["prev_id"]
        # Match native claim ordering: logical job key, scan row, then frontier/path.
        key = f"{scan_id}:{kwargs['step_id']}:{path_id}:{DISCOVERY_PATH_TABLE}:1"
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (key,))
        scan, frontier = self._discovery_lock(conn, scan_id)
        if frontier is None or scan["status"] not in _RUNNABLE:
            return None
        if int(frontier["step_id"]) != kwargs["step_id"] or int(frontier["workflow_id"]) != kwargs["workflow_id"]:
            raise ValueError("Discovery job belongs to another workflow or step")
        snapshot = self._discovery_refresh(conn, frontier, scan_status=scan["status"])
        path = next((p for p in snapshot["paths"] if int(p["id"]) == path_id), None)
        if path is None or path["status"] != "pending" or snapshot["remaining_seconds"] <= 0:
            return None
        limit = scan.get("job_limit")
        if limit is not None and int(scan.get("jobs_started") or 0) >= int(limit):
            # Preserve the native whole-workflow cap's stopped-scan transition.
            self.claim_logical_job_slot(conn, scan=scan, scan_id=scan_id, already_started=False)
            self._discovery_budget(conn, frontier, "whole_workflow_job_limit_reached")
            conn.execute(
                "UPDATE workflows.discovery_paths SET status = 'budget_stopped', reason = %s, "
                "updated_at = clock_timestamp() WHERE scan_id = %s AND status = 'pending'",
                ("Whole-workflow logical-job limit reached before this path started", scan_id),
            )
            self._discovery_refresh(conn, frontier)
            return None
        metadata_id = self.claim_step_metadata(conn, **kwargs)
        if metadata_id is not None:
            conn.execute(
                "UPDATE workflows.discovery_paths SET status = 'running', metadata_id = %s, "
                "updated_at = clock_timestamp() WHERE id = %s AND scan_id = %s AND status = 'pending'",
                (metadata_id, path_id, scan_id),
            )
        return metadata_id

    def complete_discovery_path(self, conn, scan_id, path_id, metadata_id, discovery):
        discovery = validate_discovery(discovery)
        scan, frontier = self._discovery_lock(conn, scan_id)
        if frontier is None:
            raise ValueError("Discovery frontier is missing")
        paths = self._discovery_paths(conn, scan_id)
        path = next((p for p in paths if int(p["id"]) == path_id), None)
        if path is None or path.get("metadata_id") != metadata_id:
            raise ValueError("Discovery completion does not match the claimed path")
        if path.get("completion") is not None:
            if path["completion"] == discovery:
                return
            raise ValueError("Discovery path is no longer owned by this completion")
        if path["status"] not in {"running", "blocked", "budget_stopped"}:
            raise ValueError("Discovery path is no longer owned by this completion")
        if path.get("metadata_status") != "completed":
            raise ValueError("Discovery completion requires completed native metadata in this transaction")
        closed = path["status"] != "running" or scan["status"] not in _RUNNABLE
        final_status, final_reason = discovery["status"], discovery["reason"]
        if closed:
            final_status = "budget_stopped" if path["status"] == "budget_stopped" else "blocked"
            final_reason = path.get("reason") or f"Native scan is {scan['status']}; late receipt retained"
        if _remaining(frontier) <= 0:
            self._discovery_budget(conn, frontier, "discovery_wall_time_reached")
        by_key = {p["path_key"]: p for p in paths}
        proposals = []
        for proposed in discovery["next_paths"]:
            key = path_key(proposed["scope"], proposed["question"])
            existing = by_key.get(key)
            if closed:
                disposition, target = "blocked", None
            elif existing is not None:
                disposition, target = "duplicate", int(existing["id"])
            elif len(by_key) >= frontier["max_paths"] or _remaining(frontier) <= 0:
                self._discovery_budget(
                    conn, frontier, "discovery_wall_time_reached" if _remaining(frontier) <= 0 else "max_paths_reached"
                )
                disposition, target = "budget_stopped", None
            else:
                row = conn.execute(
                    """INSERT INTO workflows.discovery_paths
                       (scan_id, step_id, parent_path_id, path_key, scope, question, rationale)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (scan_id, path_key) DO UPDATE SET path_key = EXCLUDED.path_key
                       RETURNING id""",
                    (
                        scan_id,
                        frontier["step_id"],
                        path_id,
                        key,
                        proposed["scope"],
                        proposed["question"],
                        proposed["rationale"],
                    ),
                ).fetchone()
                disposition, target = "admitted", int(row["id"])
                by_key[key] = {"id": target}
            proposals.append({**proposed, "path_key": key, "status": disposition, "path_id": target})
        conn.execute(
            """UPDATE workflows.discovery_paths SET status = %s, reason = %s,
               proposals = %s, completion = %s, updated_at = clock_timestamp()
               WHERE id = %s AND scan_id = %s AND metadata_id = %s""",
            (final_status, final_reason, Jsonb(proposals), Jsonb(discovery), path_id, scan_id, metadata_id),
        )
        self._discovery_refresh(conn, frontier, reconcile=False, scan_status=scan["status"])

    def stop_discovery_path(self, conn, scan_id, path_id, metadata_id, reason, status="blocked"):
        if status not in {"blocked", "budget_stopped"} or not isinstance(reason, str) or not reason.strip():
            raise ValueError("Invalid discovery stop disposition")
        scan, frontier = self._discovery_lock(conn, scan_id)
        if frontier is None:
            raise ValueError("Discovery frontier is missing")
        paths = self._discovery_paths(conn, scan_id)
        path = next((p for p in paths if int(p["id"]) == path_id), None)
        if path is None or path.get("metadata_id") != metadata_id:
            raise ValueError("Discovery stop does not match its claimed path")
        if path["status"] not in {"pending", "running"}:
            return
        conn.execute(
            "UPDATE workflows.discovery_paths SET status = %s, reason = %s, "
            "updated_at = clock_timestamp() WHERE id = %s AND scan_id = %s",
            (status, reason, path_id, scan_id),
        )
        if status == "budget_stopped":
            self._discovery_budget(conn, frontier, "discovery_wall_time_reached")
            conn.execute(
                "UPDATE workflows.discovery_paths SET status = 'budget_stopped', reason = %s, "
                "updated_at = clock_timestamp() WHERE scan_id = %s AND status = 'pending'",
                (reason, scan_id),
            )
        self._discovery_refresh(conn, frontier, reconcile=False, scan_status=scan["status"])

    def discovery_remaining_seconds(self, conn, scan_id):
        row = conn.execute(
            "SELECT greatest(0, extract(epoch FROM deadline_at - clock_timestamp())) AS remaining_seconds "
            "FROM workflows.discovery_frontiers WHERE scan_id = %s AND status = 'running'",
            (scan_id,),
        ).fetchone()
        return float(row["remaining_seconds"]) if row else 0.0
