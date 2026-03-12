# Deployment Guide for Dokploy

This document explains how to deploy the World Bingo application using Dokploy, specifically detailing how to configure the services so that the backend API remains secure and internal, while the Web and Admin frontends act as public gateways.

## Overview
The application consists of three main Nuxt/Node services:
1. **API**: The core backend (Fastify/Node.js). **(Internal Only)**
2. **Web**: The public-facing Nuxt 3 application for players. **(Public)**
3. **Admin**: The Nuxt 3 dashboard for administrators. **(Public)**

These services rely on Postgres (Database) and Redis (Cache and PubSub).

## Dokploy Setup Instructions

### 1. Prerequisites
- A running Dokploy instance.
- Domains pointed to your Dokploy server (e.g., `bingo.example.com` for Web, `admin.bingo.example.com` for Admin).

### 2. Create the Application Application in Dokploy
In your Dokploy dashboard, go to Applications and select **Docker Compose**.
- Connect your repository.
- Specify `infrastructure/docker-compose.yml` as the compose file.

### 3. Service Configuration Breakdown
The `docker-compose.yml` file is already optimized for this setup. Here is how Dokploy will handle it:

*   **API Service (`api`)**:
    *   **Port**: Notice that the `api` service in `docker-compose.yml` does **not** have a `ports` mapping exposed to the host machine.
    *   **Access**: It will only be accessible to other services on the internal `world-bingo-prod-network` (or `default` compose network) via the hostname `api` on port `8080`.
    *   **Action**: In Dokploy, you **do not** need to map a domain to the `api` service.

*   **Web Service (`web`)**:
    *   **Routing**: Nuxt is configured to proxy requests starting with `/api` and `/socket.io` to the internal `api` service.
    *   **Environment Variables**: Ensure `NUXT_PUBLIC_API_BASE` is set to `/api` and `NUXT_PUBLIC_WS_URL` is set to `/` in Dokploy's environment variables for this application.
    *   **Action**: In Dokploy's networking/domain settings for this application, map your primary user-facing domain (e.g., `bingo.example.com`) to port `3000` of the `web` service.

*   **Admin Service (`admin`)**:
    *   **Routing**: Similar to the Web service, Nuxt proxies `/api` and `/socket.io`.
    *   **Environment Variables**: Ensure `NUXT_PUBLIC_API_BASE` is set to `/api`.
    *   **Action**: Map your admin domain (e.g., `admin.bingo.example.com`) to port `3001` of the `admin` service.

### 4. Database and Redis
- `postgres` and `redis` services are also internal. They do not have public ports exposed.
- They will be automatically reachable by the `api` service on their respective ports (`5432` and `6379`) within the Docker network.

### 5. Environment Variables
You must set the following environment variables in your Dokploy project configuration. Dokploy passes these down to the containers automatically.

**Common Environment Variables:**
```env
# Required for APIs
NODE_ENV=production
JWT_SECRET=your_super_secret_jwt_string
CORS_ORIGIN=https://bingo.example.com,https://admin.bingo.example.com

# Database connections (defaults provided locally, but should be set for prod)
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/world_bingo
REDIS_URL=redis://redis:6379

# Web specific overrides
NUXT_PUBLIC_API_BASE=/api
NUXT_PUBLIC_WS_URL=/

# Admin specific overrides
NUXT_JWT_SECRET=your_super_secret_jwt_string_matching_api
```

### 6. Troubleshooting
- **WebSocket Connection Issues**: If games are failing to connect to WebSockets, ensure Traefik (Dokploy's router) allows WebSocket upgrades. Usually, Dokploy handles this automatically when proxying Nuxt 3. If issues persist, verify that the browser is attempting to connect to `/socket.io/` on the main domain (e.g., `https://bingo.example.com/socket.io/...`), which Nuxt will then forward to the internal API.
- **API 404 Errors on Frontend**: Ensure the `routeRules` in `nuxt.config.ts` are active and that the browser is correctly sending requests to `https://bingo.example.com/api/...`.
