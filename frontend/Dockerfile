FROM node:24.1.0-alpine3.20

WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .

EXPOSE 5173

# Reinstall on start to cover the bind-mounted source + anonymous node_modules
# volume, then run the Vite dev server bound to 0.0.0.0 so it's reachable.
CMD ["sh", "-c", "npm ci && npm run dev -- --host 0.0.0.0"]
