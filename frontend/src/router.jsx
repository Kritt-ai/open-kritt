import { createBrowserRouter } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Overview from './pages/Overview.jsx';
import Workflows from './pages/Workflows.jsx';
import WorkflowDetail from './pages/WorkflowDetail.jsx';
import WorkflowBuilder from './pages/WorkflowBuilder.jsx';
import Scans from './pages/Scans.jsx';
import ScanDetail from './pages/ScanDetail.jsx';
import VulnerabilityPage from './pages/VulnerabilityPage.jsx';
import CreateScan from './pages/CreateScan.jsx';
import PostScripts from './pages/PostScripts.jsx';
import PostScriptEditor from './pages/PostScriptEditor.jsx';
import AgentSkills from './pages/AgentSkills.jsx';
import AgentSkillEditor from './pages/AgentSkillEditor.jsx';
import SeverityRankers from './pages/SeverityRankers.jsx';
import SeverityRankerEditor from './pages/SeverityRankerEditor.jsx';
import Steps from './pages/Steps.jsx';
import AiGeneration from './pages/AiGeneration.jsx';
import Accounts from './pages/Accounts.jsx';
import CustomProviders from './pages/CustomProviders.jsx';
import Settings from './pages/Settings.jsx';

// Data router (createBrowserRouter) so pages can use useBlocker to guard
// against navigating away from unsaved work.
export const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <Overview /> },
        { path: 'workflows', element: <Workflows /> },
        { path: 'workflows/generate', element: <AiGeneration kind="workflow" /> },
        { path: 'workflows/new', element: <WorkflowBuilder /> },
        { path: 'workflows/:id', element: <WorkflowDetail /> },
        { path: 'workflows/:id/edit', element: <WorkflowBuilder /> },
        { path: 'scans', element: <Scans /> },
        { path: 'scans/new', element: <CreateScan /> },
        { path: 'scans/:id', element: <ScanDetail /> },
        { path: 'scans/:scanId/vulnerabilities/:vulnId', element: <VulnerabilityPage /> },
        { path: 'settings', element: <Settings /> },
        { path: 'accounts', element: <Accounts /> },
        { path: 'custom-providers', element: <CustomProviders /> },
        { path: 'post-scripts', element: <PostScripts /> },
        { path: 'post-scripts/generate', element: <AiGeneration kind="post_script" /> },
        { path: 'post-scripts/new', element: <PostScriptEditor /> },
        { path: 'post-scripts/:id', element: <PostScriptEditor /> },
        { path: 'agent-skills', element: <AgentSkills /> },
        { path: 'agent-skills/new', element: <AgentSkillEditor /> },
        { path: 'agent-skills/:id', element: <AgentSkillEditor /> },
        { path: 'severity-rankers', element: <SeverityRankers /> },
        { path: 'severity-rankers/new', element: <SeverityRankerEditor /> },
        { path: 'severity-rankers/:id', element: <SeverityRankerEditor /> },
        { path: 'steps', element: <Steps /> },
        { path: '*', element: <Overview /> },
      ],
    },
  ],
  { future: { v7_relativeSplatPath: true } }
);
