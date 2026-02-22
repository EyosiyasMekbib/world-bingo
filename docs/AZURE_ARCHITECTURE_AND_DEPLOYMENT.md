# World Bingo — Architecture & Azure Deployment Guide

> **Audience:** DevOps engineers, SREs, and developers deploying World Bingo to Microsoft Azure.  
> **Last updated:** 2026-02-22

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Component Breakdown](#2-component-breakdown)
3. [Data Flow Diagrams](#3-data-flow-diagrams)
4. [Azure Service Mapping](#4-azure-service-mapping)
5. [Azure Resource Architecture Diagram](#5-azure-resource-architecture-diagram)
6. [Prerequisites](#6-prerequisites)
7. [Step 1 — Resource Group & Networking](#7-step-1--resource-group--networking)
8. [Step 2 — Azure Database for PostgreSQL](#8-step-2--azure-database-for-postgresql)
9. [Step 3 — Azure Cache for Redis](#9-step-3--azure-cache-for-redis)
10. [Step 4 — Azure Blob Storage (Receipt Images)](#10-step-4--azure-blob-storage-receipt-images)
11. [Step 5 — Azure Container Registry](#11-step-5--azure-container-registry)
12. [Step 6 — Build & Push Docker Images](#12-step-6--build--push-docker-images)
13. [Step 7 — Azure Container Apps (Deployment)](#13-step-7--azure-container-apps-deployment)
14. [Step 8 — Azure Front Door (CDN + Load Balancer)](#14-step-8--azure-front-door-cdn--load-balancer)
15. [Step 9 — Monitoring & Alerting](#15-step-9--monitoring--alerting)
16. [Step 10 — CI/CD with GitHub Actions](#16-step-10--cicd-with-github-actions)
17. [Environment Variables Reference](#17-environment-variables-reference)
18. [Scaling Strategy](#18-scaling-strategy)
19. [Security Hardening](#19-security-hardening)
20. [Disaster Recovery](#20-disaster-recovery)
21. [Cost Estimation](#21-cost-estimation)
22. [Troubleshooting](#22-troubleshooting)

---

## 1. System Architecture Overview

World Bingo is a **real-time, real-money multiplayer Bingo platform** composed of:

- **3 containerised applications** (Player App, Admin Panel, API Server)
- **2 data stores** (PostgreSQL for ACID transactions, Redis for game state + pub/sub)
- **1 object store** (receipt image uploads)
- **WebSocket connections** for live gameplay with server-authoritative game logic

### Design Principles

| Principle | Implementation |
|---|---|
| **Server authority** | All ball calls, winner validation, and wallet mutations happen server-side |
| **Horizontal scalability** | Stateless API containers; Redis pub/sub bridges WebSocket instances |
| **Zero data loss on money** | All wallet operations wrapped in PostgreSQL ACID transactions |
| **Atomic game actions** | Cartela reservation via Redis `HSETNX`; wallet deductions via `SELECT FOR UPDATE` |
| **Fault tolerance** | Game state checkpointed to PostgreSQL every 30s; auto-reconnect on WS drop |
| **Leader election** | Redlock ensures only one worker calls balls per game |

---

## 2. Component Breakdown

### 2.1 Player App (`apps/web`)

| Aspect | Detail |
|---|---|
| **Framework** | Nuxt 3 (Vue 3, Nitro server) |
| **Runs on** | Port `3000` |
| **Rendering** | SSR for auth/wallet pages; CSR for game/lobby pages |
| **Real-time** | Socket.io v4 client connects to API for live game events |
| **State** | Pinia stores for auth, game, wallet |
| **Build output** | `.output/` directory — runs as `node .output/server/index.mjs` |

### 2.2 Admin Panel (`apps/admin`)

| Aspect | Detail |
|---|---|
| **Framework** | Nuxt 3 + Nuxt UI |
| **Runs on** | Port `3001` |
| **Purpose** | Deposit/withdrawal verification, game creation/management, user management |
| **Build output** | `.output/` directory — runs as `node .output/server/index.mjs` |

### 2.3 API Server (`apps/api`)

| Aspect | Detail |
|---|---|
| **Framework** | Fastify v5 + Socket.io v4 |
| **Runs on** | Port `8080` |
| **Responsibilities** | REST endpoints, WebSocket game events, Prisma ORM, BullMQ workers |
| **Auth** | JWT (`@fastify/jwt`) with Redis-backed blacklist |
| **Docs** | Auto-generated Swagger at `/docs` |
| **Metrics** | Prometheus metrics at `/metrics` |
| **Build output** | `dist/` directory |

### 2.4 PostgreSQL

| Aspect | Detail |
|---|---|
| **Version** | 16 |
| **Purpose** | Users, wallets, transactions, games, cartelas — all ACID-critical data |
| **Key pattern** | `SELECT FOR UPDATE` row-level locking on wallet operations |

### 2.5 Redis

| Aspect | Detail |
|---|---|
| **Version** | 7 (Redis Stack) |
| **Purpose** | Live game state (hashes), Socket.io adapter (pub/sub), BullMQ job queues, Redlock, session cache |
| **Key data** | `game:{id}:state`, `game:{id}:cartelas`, `game:{id}:players`, `lobby:waiting_games` |

### 2.6 Shared Packages

| Package | Purpose |
|---|---|
| `packages/shared-types` | TypeScript interfaces + Zod schemas shared across all apps |
| `packages/game-logic` | Pure TS: cartela generation, pattern detection, prize calculation, ball drawing |
| `packages/ui` | Shared Vue 3 component library |

---

## 3. Data Flow Diagrams

### 3.1 Player Joins a Game

```
Player ──POST /games/:id/join──► API Server
                                    │
                                    ├── SELECT wallet FOR UPDATE (PostgreSQL)
                                    ├── BEGIN TRANSACTION
                                    │     Deduct wallet balance
                                    │     Insert game_entry
                                    │     Assign cartela (HSETNX in Redis)
                                    ├── COMMIT
                                    ├── INCR game:playerCount (Redis)
                                    └── PUBLISH lobby:game:updated (Redis Pub/Sub)
                                          │
                                          └── All WS servers broadcast updated player count
```

### 3.2 Live Ball Calling

```
Game Engine Worker ──acquire Redlock──► Holds lock:game_engine:{gameId}
      │
      ├── Draw random ball (no replacement)
      ├── Store in game:{id}:state (Redis Hash)
      ├── PUBLISH game:{id}:number_called (Redis Pub/Sub)
      │         │
      │    ┌────┴────┐
      │    ▼         ▼
      │  WS Server A  WS Server B
      │    │              │
      │    ▼              ▼
      │  Players A     Players B
      │  (receive event simultaneously)
      │
      └── Sleep 3.5 seconds → repeat
```

### 3.3 Deposit Flow (Manual TeleBirr)

```
Player ──upload receipt──► API ──store image──► Azure Blob Storage
                            │
                            └── INSERT payment_request (PENDING) ──► PostgreSQL
                                     │
                            Admin reviews in Admin Panel
                                     │
                            ┌────────┴─────────┐
                            ▼                  ▼
                         Approve            Decline
                            │                  │
                       BEGIN TX            Update status
                        Credit wallet      Record reason
                        Record txn         Notify player
                       COMMIT
                        Notify player via WebSocket
```

### 3.4 Winner Declaration

```
Player ──POST /games/:id/claim_bingo──► API Server
                                           │
                                           ├── Acquire game lock
                                           ├── Load called numbers from Redis
                                           ├── Load player's cartela
                                           ├── Run server-side pattern detection
                                           │     (packages/game-logic)
                                           │
                                      ┌────┴────┐
                                      ▼         ▼
                                   Valid     Invalid
                                      │         │
                                 BEGIN TX    Return 400
                                  Credit winner wallet
                                  Update game → COMPLETED
                                  Record WIN transaction
                                 COMMIT
                                  WS broadcast: game:winner
                                  Redirect all players → lobby
```

---

## 4. Azure Service Mapping

| Component | GCP (Original) | **Azure Equivalent** | Azure SKU |
|---|---|---|---|
| **Container Runtime** | Cloud Run | **Azure Container Apps** | Consumption plan (scale-to-zero) |
| **Container Registry** | Artifact Registry | **Azure Container Registry (ACR)** | Basic or Standard |
| **PostgreSQL** | Cloud SQL | **Azure Database for PostgreSQL — Flexible Server** | Burstable B1ms → General Purpose D4s |
| **Redis** | Memorystore | **Azure Cache for Redis** | Basic C1 → Premium P1 |
| **Object Storage** | Cloud Storage | **Azure Blob Storage** | Hot tier |
| **CDN + Load Balancer** | Cloud Load Balancing | **Azure Front Door** | Standard or Premium |
| **Secrets** | Secret Manager | **Azure Key Vault** | Standard |
| **DNS** | Cloud DNS | **Azure DNS** | Zone |
| **Monitoring** | Cloud Monitoring | **Azure Monitor + Application Insights** | Log Analytics workspace |
| **CI/CD** | GitHub Actions + Cloud Build | **GitHub Actions + ACR Tasks** | — |
| **Logs** | Cloud Logging | **Azure Monitor Logs (Log Analytics)** | — |
| **Alerts** | Cloud Alerting | **Azure Monitor Alerts** | — |

---

## 5. Azure Resource Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            AZURE SUBSCRIPTION                                │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                    Resource Group: rg-world-bingo                       │ │
│  │                                                                         │ │
│  │              ┌────────────────────────┐                                 │ │
│  │              │   Azure Front Door     │                                 │ │
│  │              │   (CDN + WAF + LB)     │                                 │ │
│  │              │                        │                                 │ │
│  │              │  play.worldbingo.com ──────► Container App: web          │ │
│  │              │  admin.worldbingo.com ─────► Container App: admin        │ │
│  │              │  api.worldbingo.com ──────► Container App: api           │ │
│  │              └────────────────────────┘                                 │ │
│  │                         │                                               │ │
│  │         ┌───────────────┼───────────────┐                              │ │
│  │         ▼               ▼               ▼                              │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                      │ │
│  │  │  Container  │ │  Container  │ │  Container  │                      │ │
│  │  │  App: web   │ │  App: admin │ │  App: api   │                      │ │
│  │  │  (Nuxt 3)   │ │  (Nuxt 3)   │ │ (Fastify +  │                      │ │
│  │  │  Port 3000  │ │  Port 3001  │ │  Socket.io) │                      │ │
│  │  │  Min: 0     │ │  Min: 0     │ │  Port 8080  │                      │ │
│  │  │  Max: 10    │ │  Max: 3     │ │  Min: 2     │                      │ │
│  │  └─────────────┘ └─────────────┘ │  Max: 20    │                      │ │
│  │                                   └──────┬──────┘                      │ │
│  │                                          │                              │ │
│  │                          ┌───────────────┼───────────────┐             │ │
│  │                          ▼               ▼               ▼             │ │
│  │                   ┌────────────┐  ┌────────────┐  ┌────────────┐      │ │
│  │                   │ PostgreSQL │  │   Redis    │  │ Blob Store │      │ │
│  │                   │ Flexible   │  │   Cache    │  │ (receipts) │      │ │
│  │                   │ Server     │  │   for      │  │            │      │ │
│  │                   │            │  │   Redis    │  │ Hot tier   │      │ │
│  │                   │ B1ms /     │  │            │  └────────────┘      │ │
│  │                   │ D4s_v3     │  │ C1 / P1    │                      │ │
│  │                   └────────────┘  └────────────┘                      │ │
│  │                                                                         │ │
│  │  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────────┐   │ │
│  │  │  Key Vault  │  │ Container        │  │ Azure Monitor           │   │ │
│  │  │  (Secrets)  │  │ Registry (ACR)   │  │ + Application Insights  │   │ │
│  │  └─────────────┘  └──────────────────┘  └─────────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Prerequisites

Before you begin, ensure you have:

- **Azure CLI** ≥ 2.60 — [Install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- **Docker** ≥ 24 — for building images locally
- **Node.js 22+** and **pnpm 9+** — for local builds
- An **Azure Subscription** with the following providers registered:
  - `Microsoft.App` (Container Apps)
  - `Microsoft.ContainerRegistry`
  - `Microsoft.DBforPostgreSQL`
  - `Microsoft.Cache` (Redis)
  - `Microsoft.Storage`
  - `Microsoft.KeyVault`
  - `Microsoft.Cdn` (Front Door)

```bash
# Login to Azure
az login

# Register required providers
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.ContainerRegistry
az provider register --namespace Microsoft.DBforPostgreSQL
az provider register --namespace Microsoft.Cache
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.KeyVault
az provider register --namespace Microsoft.Cdn
```

---

## 7. Step 1 — Resource Group & Networking

```bash
# Variables — customise these
export RESOURCE_GROUP="rg-world-bingo"
export LOCATION="eastus"          # Choose a region close to Ethiopian users (e.g. westeurope, southafricanorth)
export ENV_NAME="world-bingo"

# Create resource group
az group create \
  --name $RESOURCE_GROUP \
  --location $LOCATION

# Create a VNet for private networking between services
az network vnet create \
  --resource-group $RESOURCE_GROUP \
  --name vnet-world-bingo \
  --address-prefix 10.0.0.0/16

# Subnet for Container Apps
az network vnet subnet create \
  --resource-group $RESOURCE_GROUP \
  --vnet-name vnet-world-bingo \
  --name snet-container-apps \
  --address-prefix 10.0.0.0/23

# Subnet for PostgreSQL (delegated)
az network vnet subnet create \
  --resource-group $RESOURCE_GROUP \
  --vnet-name vnet-world-bingo \
  --name snet-postgres \
  --address-prefix 10.0.2.0/24 \
  --delegations Microsoft.DBforPostgreSQL/flexibleServers

# Subnet for Redis
az network vnet subnet create \
  --resource-group $RESOURCE_GROUP \
  --vnet-name vnet-world-bingo \
  --name snet-redis \
  --address-prefix 10.0.3.0/24
```

---

## 8. Step 2 — Azure Database for PostgreSQL

```bash
export PG_SERVER_NAME="pg-world-bingo"
export PG_ADMIN_USER="pgadmin"
export PG_ADMIN_PASSWORD="$(openssl rand -base64 24)"    # Save this securely!
export PG_DB_NAME="world_bingo"

# Create the Flexible Server
az postgres flexible-server create \
  --resource-group $RESOURCE_GROUP \
  --name $PG_SERVER_NAME \
  --location $LOCATION \
  --admin-user $PG_ADMIN_USER \
  --admin-password "$PG_ADMIN_PASSWORD" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --vnet vnet-world-bingo \
  --subnet snet-postgres \
  --yes

# Create the database
az postgres flexible-server db create \
  --resource-group $RESOURCE_GROUP \
  --server-name $PG_SERVER_NAME \
  --database-name $PG_DB_NAME

# Enable required extensions
az postgres flexible-server parameter set \
  --resource-group $RESOURCE_GROUP \
  --server-name $PG_SERVER_NAME \
  --name azure.extensions \
  --value "PG_TRGM,UUID-OSSP"

# Get the connection string
export DATABASE_URL="postgresql://${PG_ADMIN_USER}:${PG_ADMIN_PASSWORD}@${PG_SERVER_NAME}.postgres.database.azure.com:5432/${PG_DB_NAME}?sslmode=require"
echo "DATABASE_URL=$DATABASE_URL"
```

### Production Recommendations

| Setting | Dev/Staging | Production (10K+ users) |
|---|---|---|
| **SKU** | `Standard_B1ms` (Burstable) | `Standard_D4s_v3` (General Purpose) |
| **Storage** | 32 GB | 128 GB+ |
| **High Availability** | Disabled | Zone-redundant HA |
| **Backups** | 7 days retention | 35 days, geo-redundant |
| **Read Replicas** | None | 1–2 replicas for read-heavy queries |
| **Connection Pooling** | PgBouncer built-in | Enable via server parameters |

```bash
# Enable built-in PgBouncer connection pooling
az postgres flexible-server parameter set \
  --resource-group $RESOURCE_GROUP \
  --server-name $PG_SERVER_NAME \
  --name pgbouncer.enabled \
  --value true
```

---

## 9. Step 3 — Azure Cache for Redis

```bash
export REDIS_NAME="redis-world-bingo"

# Create Redis instance
az redis create \
  --resource-group $RESOURCE_GROUP \
  --name $REDIS_NAME \
  --location $LOCATION \
  --sku Basic \
  --vm-size c1 \
  --enable-non-ssl-port

# Get the connection info
export REDIS_HOST=$(az redis show --resource-group $RESOURCE_GROUP --name $REDIS_NAME --query hostName -o tsv)
export REDIS_KEY=$(az redis list-keys --resource-group $RESOURCE_GROUP --name $REDIS_NAME --query primaryKey -o tsv)
export REDIS_URL="rediss://:${REDIS_KEY}@${REDIS_HOST}:6380"
echo "REDIS_URL=$REDIS_URL"
```

### Production Recommendations

| Setting | Dev/Staging | Production |
|---|---|---|
| **SKU** | Basic C1 (250 MB) | Premium P1 (6 GB) |
| **Clustering** | Disabled | Enable for > 10K concurrent WS connections |
| **Persistence** | None | RDB snapshots every 15 min |
| **Private Endpoint** | Optional | Required (VNet integration) |
| **Replicas** | 0 | 1–2 read replicas |

> **Why Premium for production?** World Bingo uses Redis for:
> - Game state hashes (thousands of concurrent games)
> - Socket.io pub/sub adapter (cross-instance message fan-out)
> - BullMQ job queues (refunds, notifications)
> - Redlock distributed locks (game engine leader election)
>
> Basic/Standard SKUs do not support VNet injection or data persistence.

```bash
# For production — Premium with VNet integration
az redis create \
  --resource-group $RESOURCE_GROUP \
  --name $REDIS_NAME \
  --location $LOCATION \
  --sku Premium \
  --vm-size p1 \
  --subnet-id "/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Network/virtualNetworks/vnet-world-bingo/subnets/snet-redis"
```

---

## 10. Step 4 — Azure Blob Storage (Receipt Images)

```bash
export STORAGE_ACCOUNT="stworldbingo"    # Must be globally unique, lowercase, no hyphens

# Create storage account
az storage account create \
  --resource-group $RESOURCE_GROUP \
  --name $STORAGE_ACCOUNT \
  --location $LOCATION \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false

# Create container for receipt images
az storage container create \
  --account-name $STORAGE_ACCOUNT \
  --name receipts \
  --auth-mode login

# Get connection string
export AZURE_STORAGE_CONNECTION_STRING=$(az storage account show-connection-string \
  --resource-group $RESOURCE_GROUP \
  --name $STORAGE_ACCOUNT \
  --query connectionString -o tsv)

echo "AZURE_STORAGE_CONNECTION_STRING=$AZURE_STORAGE_CONNECTION_STRING"
```

### Lifecycle Policy — Auto-delete Unverified Receipts

```bash
# Delete receipts older than 90 days to save costs
az storage account management-policy create \
  --resource-group $RESOURCE_GROUP \
  --account-name $STORAGE_ACCOUNT \
  --policy '{
    "rules": [
      {
        "name": "delete-old-receipts",
        "enabled": true,
        "type": "Lifecycle",
        "definition": {
          "filters": {
            "blobTypes": ["blockBlob"],
            "prefixMatch": ["receipts/"]
          },
          "actions": {
            "baseBlob": {
              "delete": { "daysAfterModificationGreaterThan": 90 }
            }
          }
        }
      }
    ]
  }'
```

---

## 11. Step 5 — Azure Container Registry

```bash
export ACR_NAME="acrworldbingo"    # Must be globally unique

# Create registry
az acr create \
  --resource-group $RESOURCE_GROUP \
  --name $ACR_NAME \
  --sku Basic \
  --admin-enabled true

# Login to the registry
az acr login --name $ACR_NAME

# Get the login server URL
export ACR_LOGIN_SERVER=$(az acr show --name $ACR_NAME --query loginServer -o tsv)
echo "ACR_LOGIN_SERVER=$ACR_LOGIN_SERVER"
```

---

## 12. Step 6 — Build & Push Docker Images

Run these from the **repository root** (`world-bingo/`).

```bash
# Build and tag all three images
docker build -f apps/api/Dockerfile   -t $ACR_LOGIN_SERVER/world-bingo-api:latest   .
docker build -f apps/web/Dockerfile   -t $ACR_LOGIN_SERVER/world-bingo-web:latest   .
docker build -f apps/admin/Dockerfile -t $ACR_LOGIN_SERVER/world-bingo-admin:latest .

# Push to ACR
docker push $ACR_LOGIN_SERVER/world-bingo-api:latest
docker push $ACR_LOGIN_SERVER/world-bingo-web:latest
docker push $ACR_LOGIN_SERVER/world-bingo-admin:latest
```

### Using ACR Tasks (build in the cloud — no local Docker needed)

```bash
az acr build --registry $ACR_NAME --image world-bingo-api:latest   --file apps/api/Dockerfile   .
az acr build --registry $ACR_NAME --image world-bingo-web:latest   --file apps/web/Dockerfile   .
az acr build --registry $ACR_NAME --image world-bingo-admin:latest --file apps/admin/Dockerfile .
```

---

## 13. Step 7 — Azure Container Apps (Deployment)

### 13.1 Create the Container Apps Environment

```bash
# Get subnet ID for Container Apps
export SUBNET_ID=$(az network vnet subnet show \
  --resource-group $RESOURCE_GROUP \
  --vnet-name vnet-world-bingo \
  --name snet-container-apps \
  --query id -o tsv)

# Create the environment
az containerapp env create \
  --resource-group $RESOURCE_GROUP \
  --name $ENV_NAME \
  --location $LOCATION \
  --infrastructure-subnet-resource-id $SUBNET_ID \
  --logs-destination azure-monitor
```

### 13.2 Store Secrets in Azure Key Vault

```bash
export VAULT_NAME="kv-world-bingo"

az keyvault create \
  --resource-group $RESOURCE_GROUP \
  --name $VAULT_NAME \
  --location $LOCATION

# Store secrets
az keyvault secret set --vault-name $VAULT_NAME --name "database-url"     --value "$DATABASE_URL"
az keyvault secret set --vault-name $VAULT_NAME --name "redis-url"        --value "$REDIS_URL"
az keyvault secret set --vault-name $VAULT_NAME --name "jwt-secret"       --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name $VAULT_NAME --name "storage-conn-str" --value "$AZURE_STORAGE_CONNECTION_STRING"
```

### 13.3 Deploy the API Server

```bash
export JWT_SECRET=$(az keyvault secret show --vault-name $VAULT_NAME --name jwt-secret --query value -o tsv)

az containerapp create \
  --resource-group $RESOURCE_GROUP \
  --name api \
  --environment $ENV_NAME \
  --image $ACR_LOGIN_SERVER/world-bingo-api:latest \
  --registry-server $ACR_LOGIN_SERVER \
  --target-port 8080 \
  --ingress external \
  --transport http \
  --min-replicas 2 \
  --max-replicas 20 \
  --cpu 1.0 \
  --memory 2.0Gi \
  --env-vars \
    "NODE_ENV=production" \
    "PORT=8080" \
    "HOST=0.0.0.0" \
    "DATABASE_URL=secretref:database-url" \
    "REDIS_URL=secretref:redis-url" \
    "JWT_SECRET=secretref:jwt-secret" \
    "AZURE_STORAGE_CONNECTION_STRING=secretref:storage-conn-str" \
    "AZURE_STORAGE_CONTAINER=receipts" \
    "STORAGE_PROVIDER=azure" \
    "CORS_ORIGIN=https://play.worldbingo.com,https://admin.worldbingo.com" \
  --secrets \
    "database-url=keyvaultref:https://$VAULT_NAME.vault.azure.net/secrets/database-url,identityref:/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-world-bingo" \
    "redis-url=keyvaultref:https://$VAULT_NAME.vault.azure.net/secrets/redis-url,identityref:/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-world-bingo" \
    "jwt-secret=keyvaultref:https://$VAULT_NAME.vault.azure.net/secrets/jwt-secret,identityref:/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-world-bingo" \
    "storage-conn-str=keyvaultref:https://$VAULT_NAME.vault.azure.net/secrets/storage-conn-str,identityref:/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-world-bingo" \
  --scale-rule-name http-rule \
  --scale-rule-type http \
  --scale-rule-http-concurrency 100
```

> **Important — WebSocket sticky sessions:** Container Apps supports session affinity. Enable it so Socket.io handshakes and upgrades hit the same instance:
>
> ```bash
> az containerapp ingress sticky-sessions set \
>   --resource-group $RESOURCE_GROUP \
>   --name api \
>   --affinity sticky
> ```

### 13.4 Deploy the Player App

```bash
export API_FQDN=$(az containerapp show --resource-group $RESOURCE_GROUP --name api --query properties.configuration.ingress.fqdn -o tsv)

az containerapp create \
  --resource-group $RESOURCE_GROUP \
  --name web \
  --environment $ENV_NAME \
  --image $ACR_LOGIN_SERVER/world-bingo-web:latest \
  --registry-server $ACR_LOGIN_SERVER \
  --target-port 3000 \
  --ingress external \
  --transport http \
  --min-replicas 0 \
  --max-replicas 10 \
  --cpu 0.5 \
  --memory 1.0Gi \
  --env-vars \
    "NODE_ENV=production" \
    "NUXT_PUBLIC_API_BASE=https://$API_FQDN" \
    "NUXT_PUBLIC_WS_URL=https://$API_FQDN" \
  --scale-rule-name http-rule \
  --scale-rule-type http \
  --scale-rule-http-concurrency 200
```

### 13.5 Deploy the Admin Panel

```bash
az containerapp create \
  --resource-group $RESOURCE_GROUP \
  --name admin \
  --environment $ENV_NAME \
  --image $ACR_LOGIN_SERVER/world-bingo-admin:latest \
  --registry-server $ACR_LOGIN_SERVER \
  --target-port 3001 \
  --ingress external \
  --transport http \
  --min-replicas 0 \
  --max-replicas 3 \
  --cpu 0.5 \
  --memory 1.0Gi \
  --env-vars \
    "NODE_ENV=production" \
    "NUXT_PUBLIC_API_BASE=https://$API_FQDN" \
    "NUXT_JWT_SECRET=secretref:jwt-secret" \
  --secrets \
    "jwt-secret=keyvaultref:https://$VAULT_NAME.vault.azure.net/secrets/jwt-secret,identityref:/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-world-bingo" \
  --scale-rule-name http-rule \
  --scale-rule-type http \
  --scale-rule-http-concurrency 50
```

### 13.6 Run Database Migrations

Use a one-off job in Container Apps to run Prisma migrations against the production database:

```bash
az containerapp job create \
  --resource-group $RESOURCE_GROUP \
  --name migrate-db \
  --environment $ENV_NAME \
  --image $ACR_LOGIN_SERVER/world-bingo-api:latest \
  --registry-server $ACR_LOGIN_SERVER \
  --trigger-type Manual \
  --cpu 0.5 \
  --memory 1.0Gi \
  --env-vars \
    "DATABASE_URL=secretref:database-url" \
  --secrets \
    "database-url=keyvaultref:https://$VAULT_NAME.vault.azure.net/secrets/database-url,identityref:/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-world-bingo" \
  --command "npx" "--" "prisma" "migrate" "deploy" "--schema" "./apps/api/prisma/schema.prisma"

# Execute the migration job
az containerapp job start \
  --resource-group $RESOURCE_GROUP \
  --name migrate-db
```

---

## 14. Step 8 — Azure Front Door (CDN + Load Balancer)

Azure Front Door provides global load balancing, CDN caching, WAF protection, and custom domain support.

```bash
# Create Front Door profile
az afd profile create \
  --resource-group $RESOURCE_GROUP \
  --profile-name fd-world-bingo \
  --sku Standard_AzureFrontDoor

# --- Player App endpoint ---
az afd endpoint create \
  --resource-group $RESOURCE_GROUP \
  --profile-name fd-world-bingo \
  --endpoint-name play

export WEB_FQDN=$(az containerapp show --resource-group $RESOURCE_GROUP --name web --query properties.configuration.ingress.fqdn -o tsv)

az afd origin-group create \
  --resource-group $RESOURCE_GROUP \
  --profile-name fd-world-bingo \
  --origin-group-name og-web \
  --probe-request-type GET \
  --probe-path "/health" \
  --probe-protocol Https \
  --probe-interval-in-seconds 30

az afd origin create \
  --resource-group $RESOURCE_GROUP \
  --profile-name fd-world-bingo \
  --origin-group-name og-web \
  --origin-name web-origin \
  --host-name $WEB_FQDN \
  --origin-host-header $WEB_FQDN \
  --http-port 80 \
  --https-port 443 \
  --priority 1

az afd route create \
  --resource-group $RESOURCE_GROUP \
  --profile-name fd-world-bingo \
  --endpoint-name play \
  --route-name web-route \
  --origin-group og-web \
  --supported-protocols Https \
  --https-redirect Enabled \
  --patterns-to-match "/*"
```

Repeat similar commands for the **admin** and **api** endpoints with their respective custom domains (`admin.worldbingo.com`, `api.worldbingo.com`).

### Custom Domains + SSL

```bash
# Add custom domain
az afd custom-domain create \
  --resource-group $RESOURCE_GROUP \
  --profile-name fd-world-bingo \
  --custom-domain-name play-worldbingo \
  --host-name play.worldbingo.com \
  --certificate-type ManagedCertificate

# Associate with endpoint
az afd route update \
  --resource-group $RESOURCE_GROUP \
  --profile-name fd-world-bingo \
  --endpoint-name play \
  --route-name web-route \
  --custom-domains play-worldbingo
```

---

## 15. Step 9 — Monitoring & Alerting

### 15.1 Application Insights

```bash
# Create Log Analytics workspace
az monitor log-analytics workspace create \
  --resource-group $RESOURCE_GROUP \
  --workspace-name law-world-bingo \
  --location $LOCATION

# Create Application Insights
az monitor app-insights component create \
  --resource-group $RESOURCE_GROUP \
  --app ai-world-bingo \
  --location $LOCATION \
  --workspace law-world-bingo \
  --kind web

# Get instrumentation key
export APP_INSIGHTS_KEY=$(az monitor app-insights component show \
  --resource-group $RESOURCE_GROUP \
  --app ai-world-bingo \
  --query instrumentationKey -o tsv)
```

### 15.2 Key Alerts to Configure

| Alert | Condition | Severity |
|---|---|---|
| **API P99 latency** | > 500ms for 5 min | Warning (Sev 2) |
| **API error rate** | > 5% of requests return 5xx | Critical (Sev 1) |
| **Container restarts** | > 3 restarts in 10 min | Critical (Sev 1) |
| **PostgreSQL CPU** | > 80% for 10 min | Warning (Sev 2) |
| **PostgreSQL connections** | > 80% of max | Critical (Sev 1) |
| **Redis memory** | > 80% of allocated | Warning (Sev 2) |
| **Redis evictions** | > 0 | Critical (Sev 1) |
| **BullMQ queue depth** | > 1000 waiting jobs | Warning (Sev 2) |
| **Blob storage failures** | > 10 failed uploads/min | Warning (Sev 2) |

```bash
# Example: Alert on API error rate
az monitor metrics alert create \
  --resource-group $RESOURCE_GROUP \
  --name "api-high-error-rate" \
  --scopes "/subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/api" \
  --condition "avg Requests where StatusCodeClass == 5xx > 5" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --severity 1 \
  --description "API returning more than 5% server errors"
```

### 15.3 Grafana on Azure (Optional — alongside Azure Monitor)

If you prefer the existing Prometheus + Grafana dashboards from the repo, deploy **Azure Managed Grafana**:

```bash
az grafana create \
  --resource-group $RESOURCE_GROUP \
  --name grafana-world-bingo \
  --location $LOCATION

# Link Azure Monitor as a datasource (auto-configured with Managed Grafana)
```

Import the existing dashboard from `infrastructure/grafana/dashboards/world-bingo-api.json`.

---

## 16. Step 10 — CI/CD with GitHub Actions

Create `.github/workflows/deploy-azure.yml`:

```yaml
name: Build & Deploy to Azure

on:
  push:
    branches: [main]

env:
  RESOURCE_GROUP: rg-world-bingo
  ACR_NAME: acrworldbingo
  LOCATION: eastus

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Login to Azure
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Login to ACR
        run: az acr login --name ${{ env.ACR_NAME }}

      - name: Set image tag
        run: echo "IMAGE_TAG=$(echo $GITHUB_SHA | head -c 7)" >> $GITHUB_ENV

      # ── Build & Push ──────────────────────────────────────
      - name: Build & push API image
        run: |
          docker build -f apps/api/Dockerfile -t ${{ env.ACR_NAME }}.azurecr.io/world-bingo-api:${{ env.IMAGE_TAG }} .
          docker push ${{ env.ACR_NAME }}.azurecr.io/world-bingo-api:${{ env.IMAGE_TAG }}

      - name: Build & push Web image
        run: |
          docker build -f apps/web/Dockerfile -t ${{ env.ACR_NAME }}.azurecr.io/world-bingo-web:${{ env.IMAGE_TAG }} .
          docker push ${{ env.ACR_NAME }}.azurecr.io/world-bingo-web:${{ env.IMAGE_TAG }}

      - name: Build & push Admin image
        run: |
          docker build -f apps/admin/Dockerfile -t ${{ env.ACR_NAME }}.azurecr.io/world-bingo-admin:${{ env.IMAGE_TAG }} .
          docker push ${{ env.ACR_NAME }}.azurecr.io/world-bingo-admin:${{ env.IMAGE_TAG }}

      # ── Run Migrations ────────────────────────────────────
      - name: Run database migrations
        run: |
          az containerapp job start \
            --resource-group ${{ env.RESOURCE_GROUP }} \
            --name migrate-db

      # ── Deploy ────────────────────────────────────────────
      - name: Deploy API
        run: |
          az containerapp update \
            --resource-group ${{ env.RESOURCE_GROUP }} \
            --name api \
            --image ${{ env.ACR_NAME }}.azurecr.io/world-bingo-api:${{ env.IMAGE_TAG }}

      - name: Deploy Web
        run: |
          az containerapp update \
            --resource-group ${{ env.RESOURCE_GROUP }} \
            --name web \
            --image ${{ env.ACR_NAME }}.azurecr.io/world-bingo-web:${{ env.IMAGE_TAG }}

      - name: Deploy Admin
        run: |
          az containerapp update \
            --resource-group ${{ env.RESOURCE_GROUP }} \
            --name admin \
            --image ${{ env.ACR_NAME }}.azurecr.io/world-bingo-admin:${{ env.IMAGE_TAG }}

      # ── Smoke Test ────────────────────────────────────────
      - name: Health check
        run: |
          API_FQDN=$(az containerapp show --resource-group ${{ env.RESOURCE_GROUP }} --name api --query properties.configuration.ingress.fqdn -o tsv)
          curl --fail --retry 5 --retry-delay 10 "https://$API_FQDN/health"
```

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `AZURE_CLIENT_ID` | Service principal or managed identity client ID |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |

Set up a federated credential for passwordless OIDC authentication:

```bash
# Create a service principal
az ad sp create-for-rbac --name "sp-world-bingo-deploy" --role contributor \
  --scopes /subscriptions/<sub-id>/resourceGroups/$RESOURCE_GROUP

# Add federated credential for GitHub Actions
az ad app federated-credential create \
  --id <app-object-id> \
  --parameters '{
    "name": "github-deploy",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<github-org>/world-bingo:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

---

## 17. Environment Variables Reference

### API Server (`apps/api`)

| Variable | Description | Example |
|---|---|---|
| `NODE_ENV` | Runtime environment | `production` |
| `PORT` | HTTP port | `8080` |
| `HOST` | Bind address | `0.0.0.0` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
| `REDIS_URL` | Redis connection string | `rediss://:key@host:6380` |
| `JWT_SECRET` | Secret for signing JWTs | `<random 32-byte base64>` |
| `CORS_ORIGIN` | Allowed origins (comma-separated) | `https://play.worldbingo.com,https://admin.worldbingo.com` |
| `STORAGE_PROVIDER` | Storage backend | `azure` (or `local`, `gcs`) |
| `AZURE_STORAGE_CONNECTION_STRING` | Blob Storage connection string | `DefaultEndpointsProtocol=https;...` |
| `AZURE_STORAGE_CONTAINER` | Blob container name | `receipts` |
| `UPLOAD_DIR` | Local fallback upload directory | `/app/uploads` |

### Player App (`apps/web`)

| Variable | Description | Example |
|---|---|---|
| `NUXT_PUBLIC_API_BASE` | API base URL | `https://api.worldbingo.com` |
| `NUXT_PUBLIC_WS_URL` | WebSocket URL | `https://api.worldbingo.com` |

### Admin Panel (`apps/admin`)

| Variable | Description | Example |
|---|---|---|
| `NUXT_PUBLIC_API_BASE` | API base URL | `https://api.worldbingo.com` |
| `NUXT_JWT_SECRET` | JWT secret for admin auth | Same as API `JWT_SECRET` |

---

## 18. Scaling Strategy

### Auto-scaling Rules (Container Apps)

| App | Min Replicas | Max Replicas | Scale Trigger |
|---|---|---|---|
| **api** | 2 | 20 | 100 concurrent HTTP requests per replica |
| **web** | 0 (scale-to-zero) | 10 | 200 concurrent HTTP requests per replica |
| **admin** | 0 (scale-to-zero) | 3 | 50 concurrent HTTP requests per replica |

### When to Scale Up Infrastructure

| Concurrent Users | API Replicas | Redis SKU | PostgreSQL SKU |
|---|---|---|---|
| < 1,000 | 2 | Basic C1 | Burstable B1ms |
| 1K–5K | 5 | Standard C2 | General Purpose D2s_v3 |
| 5K–10K | 10 | Premium P1 | General Purpose D4s_v3 |
| 10K–50K | 20 | Premium P3 (clustered) | D8s_v3 + 1 read replica |
| 50K+ | 30+ | Premium P5 (clustered) | D16s_v3 + 2 read replicas |

### WebSocket-Specific Scaling

Azure Container Apps supports WebSocket connections. Key configuration:

1. **Session affinity** — enabled on the `api` container app (sticky sessions for Socket.io handshake)
2. **Redis adapter** — Socket.io uses the Redis adapter so that messages are fanned out across all API replicas
3. **Idle timeout** — set to 3600s (1 hour) for persistent game connections:

```bash
az containerapp ingress update \
  --resource-group $RESOURCE_GROUP \
  --name api \
  --proxy-read-timeout 3600 \
  --proxy-send-timeout 3600
```

---

## 19. Security Hardening

### 19.1 Network Isolation

```
Internet ──► Azure Front Door (WAF) ──► Container Apps Environment (VNet)
                                              │
                                              ├── PostgreSQL (VNet-integrated, private endpoint)
                                              ├── Redis (VNet-integrated or private endpoint)
                                              └── Blob Storage (private endpoint)
```

- **No public IPs** on databases — all access goes through private endpoints in the VNet.
- **Azure Front Door WAF** blocks OWASP Top 10 attacks, rate limits, and geo-filters.

### 19.2 Authentication & Secrets

- All secrets stored in **Azure Key Vault** and injected as Container Apps secret references.
- JWT tokens are **short-lived** (15 min access, 7d refresh).
- Redis session blacklist for immediate token revocation on logout.

### 19.3 Admin Panel IP Restriction

Restrict admin access to specific IP ranges:

```bash
az containerapp ingress access-restriction set \
  --resource-group $RESOURCE_GROUP \
  --name admin \
  --rule-name allow-office \
  --action Allow \
  --ip-address "203.0.113.0/24" \
  --description "Office IP only"
```

### 19.4 Additional Measures

| Area | Implementation |
|---|---|
| **Rate limiting** | `@fastify/rate-limit` (Redis-backed, per-IP and per-user) |
| **CORS** | Strict origin list; no wildcards in production |
| **Input validation** | Zod schemas on every request body |
| **File upload** | MIME type validation, 5 MB max, JPEG/PNG only |
| **Password hashing** | bcrypt with cost factor 12 |
| **SQL injection** | Prisma ORM parameterized queries (no raw SQL unless explicitly needed) |
| **Container security** | Non-root user in all Dockerfiles (`appuser`) |

---

## 20. Disaster Recovery

### 20.1 Backup Strategy

| Component | Backup Method | Retention | RPO |
|---|---|---|---|
| **PostgreSQL** | Azure automated backups | 35 days | 5 min (point-in-time restore) |
| **PostgreSQL** | Geo-redundant backup | 35 days | < 1 hour (cross-region) |
| **Redis** | RDB snapshots (Premium) | 24 hours | 15 min |
| **Blob Storage** | LRS replication (Standard) | N/A | 0 (synchronous) |
| **Blob Storage** | GRS replication (if needed) | N/A | < 15 min (async) |

### 20.2 Failure Scenarios

| Scenario | Mitigation | RTO |
|---|---|---|
| **API container crash** | Container Apps auto-restarts; min 2 replicas ensure no downtime | < 30 seconds |
| **Redis failure during game** | Game state checkpointed to PostgreSQL every 30s; engine reloads on reconnect | < 30 seconds |
| **Database failover** | Zone-redundant HA with automatic failover | < 60 seconds |
| **WS server crash** | Socket.io client auto-reconnects to another replica; Redis adapter maintains pub/sub | 2–5 seconds |
| **Region outage** | Geo-redundant PG backup + new Container Apps deployment in secondary region | < 1 hour |

### 20.3 PostgreSQL Point-in-Time Restore

```bash
az postgres flexible-server restore \
  --resource-group $RESOURCE_GROUP \
  --name pg-world-bingo-restored \
  --source-server pg-world-bingo \
  --restore-time "2026-02-22T10:00:00Z"
```

---

## 21. Cost Estimation

Monthly costs for a **staging** environment (low traffic):

| Resource | SKU | Estimated Cost/mo |
|---|---|---|
| Container Apps (api × 2) | 1 vCPU, 2 GB | ~$60 |
| Container Apps (web × 1) | 0.5 vCPU, 1 GB | ~$15 |
| Container Apps (admin × 1) | 0.5 vCPU, 1 GB | ~$15 |
| PostgreSQL Flexible Server | Burstable B1ms | ~$13 |
| Azure Cache for Redis | Basic C1 | ~$25 |
| Blob Storage (10 GB) | Hot LRS | ~$1 |
| Azure Front Door | Standard | ~$35 |
| Key Vault | Standard (10K ops) | ~$1 |
| Container Registry | Basic | ~$5 |
| Log Analytics | 5 GB/mo ingestion | Free tier |
| **Total** | | **~$170/mo** |

Monthly costs for **production** (10K+ concurrent users):

| Resource | SKU | Estimated Cost/mo |
|---|---|---|
| Container Apps (api × 10) | 1 vCPU, 2 GB | ~$300 |
| Container Apps (web × 5) | 0.5 vCPU, 1 GB | ~$75 |
| Container Apps (admin × 1) | 0.5 vCPU, 1 GB | ~$15 |
| PostgreSQL Flexible Server | General Purpose D4s_v3, HA | ~$400 |
| Azure Cache for Redis | Premium P1 (6 GB) | ~$225 |
| Blob Storage (100 GB) | Hot LRS | ~$2 |
| Azure Front Door | Standard | ~$35 |
| Key Vault + Monitor + ACR | — | ~$30 |
| **Total** | | **~$1,080/mo** |

> Costs are approximate and vary by region. Use the [Azure Pricing Calculator](https://azure.microsoft.com/en-us/pricing/calculator/) for exact numbers.

---

## 22. Troubleshooting

### Container won't start

```bash
# Check logs
az containerapp logs show \
  --resource-group $RESOURCE_GROUP \
  --name api \
  --follow

# Check system logs (events, restarts)
az containerapp revision list \
  --resource-group $RESOURCE_GROUP \
  --name api \
  -o table
```

### Database connection refused

```bash
# Verify the Container Apps env can reach PostgreSQL
az containerapp exec \
  --resource-group $RESOURCE_GROUP \
  --name api \
  --command "node -e \"const pg = require('pg'); const c = new pg.Client(process.env.DATABASE_URL); c.connect().then(() => { console.log('OK'); c.end(); }).catch(console.error);\""

# Check PostgreSQL firewall / VNet integration
az postgres flexible-server show \
  --resource-group $RESOURCE_GROUP \
  --name $PG_SERVER_NAME \
  --query network
```

### Redis connection timeout

```bash
# Verify Redis connectivity
az redis show \
  --resource-group $RESOURCE_GROUP \
  --name $REDIS_NAME \
  --query "[provisioningState, hostName, port, sslPort]"

# For Premium with VNet — ensure subnet NSG allows outbound to Redis
```

### WebSocket connections dropping

1. Verify session affinity is enabled (`sticky` mode).
2. Check proxy timeouts are set to 3600s (not the default 240s).
3. Ensure Azure Front Door's WebSocket support is active (enabled by default on Standard/Premium SKU).
4. Check Redis adapter logs — if pub/sub is disconnected, WS messages won't fan out across replicas.

### Prisma migrations fail

```bash
# Check migration job logs
az containerapp job execution list \
  --resource-group $RESOURCE_GROUP \
  --name migrate-db \
  -o table

# View specific execution logs
az containerapp job execution show \
  --resource-group $RESOURCE_GROUP \
  --name migrate-db \
  --job-execution-name <execution-name>
```

### Out-of-memory (OOM) on API containers

The API server holds game state references and Socket.io connections in memory. If you see OOM restarts:

1. Increase memory from 2 GB to 4 GB.
2. Reduce `max-replicas` threshold to spread load earlier.
3. Check for memory leaks with `--inspect` flag and Chrome DevTools.

---

## Quick Reference — Full Deployment Checklist

```
☐ 1.  Create resource group and VNet
☐ 2.  Provision PostgreSQL Flexible Server
☐ 3.  Provision Azure Cache for Redis
☐ 4.  Create Blob Storage account + receipts container
☐ 5.  Create Azure Container Registry
☐ 6.  Build & push Docker images (api, web, admin)
☐ 7.  Create Azure Key Vault and store secrets
☐ 8.  Create Container Apps Environment
☐ 9.  Deploy api Container App (min 2 replicas, sticky sessions)
☐ 10. Deploy web Container App (scale-to-zero)
☐ 11. Deploy admin Container App (scale-to-zero, IP restricted)
☐ 12. Run Prisma migrations via Container App Job
☐ 13. Seed database (cartelas, admin user)
☐ 14. Set up Azure Front Door with custom domains + SSL
☐ 15. Configure DNS (play.worldbingo.com, admin.worldbingo.com, api.worldbingo.com)
☐ 16. Set up Application Insights + alerts
☐ 17. Configure GitHub Actions CI/CD pipeline
☐ 18. Run smoke tests against production URLs
☐ 19. Verify WebSocket connectivity (join a test game)
☐ 20. Verify deposit flow (upload receipt → admin approve → wallet credited)
```
