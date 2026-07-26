\# Open Kritt Custom



> A customized version of Open Kritt with support for custom AI providers and OpenAI-compatible APIs.



\---



\## Introduction



Open Kritt Custom is a customized fork of the original Open Kritt project that extends its provider architecture to support custom AI providers and OpenAI-compatible APIs.



The primary goal of this fork is to make model integration more flexible by allowing developers to connect custom providers, configure OpenAI-compatible endpoints, and register their own models without being limited to the project's built-in integrations.



\---



\## Features Added



\### Custom AI Provider Integration

\- Register and configure custom AI providers

\- Connect any OpenAI-compatible API

\- Support custom API endpoints and authentication



\### Flexible Model Management

\- Register provider-specific models

\- Organize and switch between available models

\- Support custom model catalogs



\### Automatic CLI Detection

\- Automatically detects existing Claude Code installations

\- Automatically detects existing Codex CLI installations

\- Reuses existing local authentication when available

\- Eliminates manual CLI configuration for supported providers



\---



\## Getting Started



\## Prerequisites



Before getting started, ensure the following are installed on your system:



\- Docker

\- Docker Compose

\- Git



\## Installation



\### 1. Clone the Repository



```bash

git clone https://github.com/nishanm15/open-kritt-custom.git

cd open-kritt-custom

```



\### 2. Start the Application



Build and start all services (once):



```bash

docker compose build --no-cache

```



On subsequent runs, you can start the application without rebuilding:



```bash

docker compose up

```



To run the services in the background:



```bash

docker compose up -d

```



\### 4. Access the Application



Once all services are running, open the frontend in your browser:



```

http://localhost:5173

```



The backend, engine, and database will be started automatically by Docker Compose.



\## Adding Custom Providers







\---



\## Credits



This project is based on the original \*\*Open Kritt\*\* project.



Modified and maintained by \*\*@nishanm15\*\*



GitHub: https://github.com/nishanm15



X: https://x.com/0xnishanm15



Nishan Mishra



\---



\## License



This repository remains licensed under the \*\*GNU Affero General Public License v3.0 (AGPL-3.0)\*\*.

