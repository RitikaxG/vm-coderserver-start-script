# code-vm-agent

`code-vm-agent` is the lightweight control agent that runs on every SpinUp EC2 VM.

It exposes a small HTTP API on port `3000` so the SpinUp backend can start, stop, and inspect the code-server Docker container without SSH.

Repository:

```text
https://github.com/RitikaxG/vm-coderserver-start-script
```

---

## Why this app exists

The Auto Scaling Group only manages EC2 machines.

Once a VM is running, SpinUp still needs to control the workspace container on that VM.

This agent solves that problem.

Instead of the backend SSH-ing into the VM, the backend calls:

```text
http://<EC2_PUBLIC_IP>:3000
```

Then the agent runs local Docker commands.

---

## Where it fits

```text
SpinUp backend
  → calls code-vm-agent on port 3000
  → agent runs Docker commands
  → my-code-server container starts
  → code-server workspace runs on port 8080
```

Port split:

```text
3000 = VM agent API
8080 = user code-server workspace
```

The backend talks to `3000`.

The user opens `8080`.

---

## VM Agent Interaction

![VM Agent Interaction](../../docs/images/vm_agent_interaction.png)

## What this app does

The agent provides four endpoints.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Confirms the VM agent is alive |
| `POST /start` | Starts or reuses the workspace container |
| `POST /stop` | Stops/removes the workspace container |
| `POST /containerStatus` | Reports whether the container is running or stopped |

---

## Start container flow

The backend calls:

```text
POST /start
```

with:

```json
{
  "projectId": "project_123",
  "projectName": "SpinUp Demo",
  "projectType": "NEXTJS",
  "containerName": "spinup-project_123"
}
```

The agent then checks Docker.

### Case 1: container already running

It returns success and reuses the container.

### Case 2: container exists but is stopped

It starts the existing container.

### Case 3: container does not exist

It creates a new container:

```bash
docker run -d \
  --name spinup-<projectId> \
  -e PROJECT_ID=<projectId> \
  -e PROJECT_NAME=<projectName> \
  -e PROJECT_TYPE=<projectType> \
  -p 8080:8080 \
  my-code-server
```

This makes the start flow retry-safe.

---

## Stop container flow

The backend calls:

```text
POST /stop
```

with:

```json
{
  "containerName": "spinup-project_123"
}
```

The agent removes the container with:

```bash
docker rm -f <containerName>
```

If the container is already missing, the agent treats it as success.

This helps cleanup converge safely.

---

## Container status flow

The backend calls:

```text
POST /containerStatus
```

with:

```json
{
  "containerName": "spinup-project_123"
}
```

The agent returns:

```text
running
```

or:

```text
stopped
```

The control plane uses this during readiness checks and heartbeat checks.

---

## Why the agent is idempotent

The backend may retry requests.

So the agent is designed to handle repeated calls safely:

```text
/start on running container = success
/start on stopped container = start it
/stop on missing container = success
/containerStatus on missing container = stopped
```

This prevents duplicate containers and makes cleanup safer.

---

## VM requirements

The AMI should have:

- Docker installed
- Docker enabled on boot
- Ubuntu user allowed to run Docker
- Node/Bun installed
- this repo cloned
- dependencies installed with `bun install`
- `my-code-server` image pulled and tagged locally
- this agent running through `systemd`

---

## Example systemd service

```ini
[Unit]
Description=SpinUp VM Agent
After=network.target docker.service
Requires=docker.service

[Service]
ExecStart=/home/ubuntu/.nvm/versions/node/v24.15.0/bin/bun index.ts
WorkingDirectory=/home/ubuntu/vm-coderserver-start-script
Restart=always
RestartSec=5
User=ubuntu
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent
sudo systemctl start agent
sudo systemctl status agent
```

---

## How the backend uses it

During project creation, the backend:

```text
1. allocates an EC2 VM
2. waits for public IP
3. checks GET /health on port 3000
4. calls POST /start
5. waits for /containerStatus or code-server readiness
6. marks project READY
```

During cleanup, the backend:

```text
1. calls POST /stop
2. checks whether VM is still healthy
3. returns healthy VM to idle pool or terminates bad VM
```

---

## Does this app need AWS credentials?

No.

This agent does not call AWS APIs.

It only controls local Docker on the VM.

S3 access happens inside the `my-code-server` container through `vm-base-config`, using the EC2 instance role.

---

## Summary

`code-vm-agent` is the per-VM Docker controller for SpinUp.

It is responsible for:

```text
VM health check
workspace container start
workspace container stop
workspace container status
safe retry behavior
```

AWS manages the machines. This agent manages the Docker workspace on each machine.
