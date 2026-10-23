import pytest

from open_kritt_engine.config import EngineConfig


@pytest.mark.parametrize("raw", ["not-a-number", "nan", "inf", "-inf"])
def test_invalid_storage_setting_preserves_safe_default(monkeypatch, tmp_path, raw):
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    monkeypatch.setenv("ENGINE_MIN_FREE_STORAGE_GB", raw)

    assert EngineConfig.from_env().min_free_storage_bytes == 20 * 1024**3


@pytest.mark.parametrize(
    "name, expected",
    [
        ("ENGINE_MIN_FREE_STORAGE_GB", 20 * 1024**3),
        ("ENGINE_DOCKER_BUILD_CACHE_KEEP_GB", 0),
    ],
)
@pytest.mark.parametrize("raw", ["1e308", "8589934592"])
def test_finite_storage_values_above_supported_byte_range_use_default(monkeypatch, tmp_path, name, expected, raw):
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    monkeypatch.setenv(name, raw)

    config = EngineConfig.from_env()
    actual = (
        config.min_free_storage_bytes if name == "ENGINE_MIN_FREE_STORAGE_GB" else config.docker_build_cache_keep_bytes
    )
    assert actual == expected


@pytest.mark.parametrize("raw, expected", [("0", 0), ("1.5", int(1.5 * 1024**3)), ("20", 20 * 1024**3)])
def test_finite_storage_settings_keep_their_configured_value(monkeypatch, tmp_path, raw, expected):
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    monkeypatch.setenv("ENGINE_MIN_FREE_STORAGE_GB", raw)

    assert EngineConfig.from_env().min_free_storage_bytes == expected


@pytest.mark.parametrize("name", ["ENGINE_MIN_FREE_STORAGE_GB", "ENGINE_DOCKER_BUILD_CACHE_KEEP_GB"])
def test_fractional_storage_value_within_supported_byte_range_is_kept(monkeypatch, tmp_path, name):
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    monkeypatch.setenv(name, "8589934591.5")

    config = EngineConfig.from_env()
    actual = (
        config.min_free_storage_bytes if name == "ENGINE_MIN_FREE_STORAGE_GB" else config.docker_build_cache_keep_bytes
    )
    assert actual == int(8589934591.5 * 1024**3)


@pytest.mark.parametrize("raw", ["nan", "inf", "-inf"])
def test_other_float_settings_also_reject_nonfinite_values(monkeypatch, tmp_path, raw):
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    monkeypatch.setenv("ENGINE_POLL_SECONDS", raw)
    monkeypatch.setenv("ENGINE_MODEL_CATALOG_TIMEOUT_SECONDS", raw)
    monkeypatch.setenv("ENGINE_DOCKER_BUILD_CACHE_KEEP_GB", raw)

    config = EngineConfig.from_env()
    assert config.poll_seconds == 5.0
    assert config.model_catalog_timeout_seconds == 10.0
    assert config.docker_build_cache_keep_bytes == 0
