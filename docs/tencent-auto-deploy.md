# Tencent Auto Deploy

This project can auto-deploy to the Tencent Lighthouse server after pushes to `master`.

## Workflow

- GitHub Actions workflow: `.github/workflows/tencent-deploy.yml`
- Server deploy hook: `/var/www/aiprograms/deploy-after-upload.sh`
- App service: `aiprograms.service`
- Reverse proxy: `nginx`

The workflow only syncs code to the server. Sensitive runtime config stays on the server in:

```bash
/var/www/aiprograms/current/.env.production
```

## GitHub Secrets

Add these repository secrets:

- `TENCENT_HOST`
  - Example: `1.12.62.172`
- `TENCENT_USER`
  - Example: `ubuntu`
- `TENCENT_SSH_KEY`
  - The private key content for the deploy-only SSH key

## Server-side Deploy Command

The workflow runs this command on the server:

```bash
bash /var/www/aiprograms/deploy-after-upload.sh
```

That script will:

1. install dependencies with `pnpm install --frozen-lockfile`
2. build the Next.js app
3. restart `aiprograms.service`
4. run a local health check against `http://127.0.0.1:3000/api/me/`

## Useful Server Commands

```bash
sudo systemctl status aiprograms
sudo journalctl -u aiprograms -f
sudo systemctl restart aiprograms
sudo nginx -t
sudo systemctl reload nginx
```
