# Local Docker networking notes

The committed `docker-compose.yml` uses normal bridge networking with the service hostname `postgres`. That is the correct default for typical Docker Desktop / Linux hosts.

## Restricted environments

On some CI/sandbox hosts, container bridge FORWARD rules drop API to Postgres traffic. For those environments only, use an untracked host-network override:

```bash
# DO NOT commit this file
cat > /tmp/compose.hostnet.yml <<'YAML'
services:
  api:
    network_mode: host
    environment:
      DATABASE_URL: postgresql://postgres:LocalTestPassword123@127.0.0.1:5432/grow_bangladesh
      DATABASE_SSL: "false"
    depends_on:
      postgres:
        condition: service_healthy
YAML

sudo docker compose -f docker-compose.yml -f /tmp/compose.hostnet.yml up --build
```

Data persistence still uses the named volume `grow_bangladesh_postgres`. Prefer `docker compose stop` over `docker compose down -v`.
