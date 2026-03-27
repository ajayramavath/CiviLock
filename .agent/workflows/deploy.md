---
description: How to deploy code changes and/or .env changes to the production Linux server
---

# Deployment Workflow

## Prerequisites
- SSH access to the production server
- Git repo is up to date locally (`git push` done)
- The project lives at the same path on the server, cloned from GitHub

---

## Scenario A: Code-Only Changes (no .env changes)

This is the most common deploy. Redis data is untouched. Only the bot container is rebuilt.

### Steps

1. **Push your code from local machine:**
```bash
git add -A && git commit -m "describe your change" && git push origin main
```

2. **SSH into the server:**
```bash
ssh your-server
```

3. **Pull the latest code:**
```bash
cd /path/to/scheduler
git pull origin main
```

4. **Rebuild ONLY the bot (Redis stays running, no data loss):**
```bash
docker compose up -d --build --no-deps bot
```

> `--build` = rebuild the image with new code
> `--no-deps` = don't touch Redis
> `-d` = detached

5. **Verify it's running:**
```bash
docker compose ps
docker logs civilock-bot --tail 50
```

6. **Quick health check — send a test message to the bot on Telegram and verify response looks clean.**

---

## Scenario B: Code + .env Changes

The `.env` file lives on the server only (not in the Docker image, thanks to `.dockerignore`). So you edit it directly on the server.

### Steps

1. **Push code changes from local machine:**
```bash
git add -A && git commit -m "describe your change" && git push origin main
```

2. **SSH into the server:**
```bash
ssh your-server
```

3. **Pull the latest code:**
```bash
cd /path/to/scheduler
git pull origin main
```

4. **Edit .env on the server:**
```bash
nano .env
# Make your changes, save with Ctrl+X → Y → Enter
```

5. **Rebuild and restart the bot:**
```bash
docker compose up -d --build --no-deps bot
```

6. **Verify:**
```bash
docker compose ps
docker logs civilock-bot --tail 50
```

---

## Scenario C: .env-Only Changes (no code changes)

### Steps

1. **SSH into the server.**

2. **Edit .env:**
```bash
cd /path/to/scheduler
nano .env
```

3. **Restart the bot (no rebuild needed, just pick up new env vars):**
```bash
docker compose up -d --no-deps --force-recreate bot
```

> `--force-recreate` = restarts even if image hasn't changed, so new env vars are picked up

4. **Verify:**
```bash
docker compose ps
docker logs civilock-bot --tail 50
```

---

## Rollback (if something goes wrong)

### Option 1: Rollback code
```bash
# On the server
git log --oneline -5          # find the last good commit
git checkout <commit-hash>    # go back to it
docker compose up -d --build --no-deps bot
```

### Option 2: Rollback .env
```bash
# If you broke .env, fix it manually
nano .env
docker compose up -d --no-deps --force-recreate bot
```

---

## What's Safe / What's NOT

| Action | Data Loss Risk | Downtime |
|--------|---------------|----------|
| `docker compose up -d --build --no-deps bot` | ✅ None (Redis untouched) | ~5-15s (bot restarts) |
| `docker compose up -d --force-recreate bot` | ✅ None | ~2-5s |
| `docker compose down` | ⚠️ Redis data persists (volume) but bot stops | Until `up` again |
| `docker compose down -v` | 🚨 **DELETES Redis volume** | Full data loss |
| `docker volume rm` | 🚨 **DELETES data** | Full data loss |

### NEVER run:
- `docker compose down -v` (destroys Redis data)
- `docker system prune -a` (removes all images including Redis data potentially)

---

## Quick Reference (copy-paste for server)

### Most common deploy (code only):
```bash
cd /path/to/scheduler && git pull origin main && docker compose up -d --build --no-deps bot && docker logs civilock-bot --tail 30
```
