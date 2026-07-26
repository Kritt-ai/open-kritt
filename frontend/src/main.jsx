import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router.jsx';
import { ThemeProvider, ChromeProvider } from './context/ui.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <ChromeProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </ChromeProvider>
    </ThemeProvider>
  </React.StrictMode>
);
