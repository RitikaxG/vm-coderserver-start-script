# vm-coderserver-start-script

## Overview
`vm-coderserver-start-script` is the lightweight per-VM control agent for SpinUp. It runs as a long-lived Bun service on each EC2 VM and translates simple HTTP requests into local Docker actions. In the current implementation, the agent defines Express handlers for `/health`, `/start`, `/stop`, and `/containerStatus`, and shells out to Docker to inspect, start, create, or remove the `my-code-server` container. The `/start` path injects `PROJECT_ID`, `PROJECT_NAME`, and `PROJECT_TYPE` into the container and exposes port `8080:8080`; if no explicit container name is passed, it defaults to `spinup-${projectId}`. 

## Why this service exists
SpinUp has two different layers of orchestration:

1. **VM lifecycle**: AWS launches and terminates EC2 instances through an Auto Scaling Group.
2. **Workspace lifecycle**: once a VM is alive, SpinUp still needs a small local supervisor to start a project workspace container, restart an existing one, stop it, and report its status.

This repo fills the second gap. Without it, our backend would need to SSH into every VM or bake more orchestration directly into cloud-init/user-data. Instead, the VM exposes a tiny, idempotent control plane that speaks “start this workspace”, “stop this workspace”, and “tell me if it is already running”. The current code explicitly handles the idempotent cases of “container already running”, “container exists but is stopped”, and “container already absent”. 

## Where it fits in SpinUp
The agent sits **inside each VM** that our launch template / ASG creates.

High-level placement:

`SpinUp backend -> VM agent -> Docker container (my-code-server) -> code-server workspace`

Typical flow:

1. AWS launches a VM from our AMI and launch template.
2. The VM comes up with Docker, Node/Bun, and this agent installed as a `systemd` service.
3. SpinUp calls the agent’s `/start` endpoint with `projectId`, `projectName`, and `projectType`.
4. The agent either reuses an existing container or runs a new `my-code-server` container.
5. The container bootstraps the workspace and starts code-server on port 8080. 

## What it provides

### 1. Health endpoint
`GET /health` returns `200 OK`, which is useful for VM readiness checks. 

### 2. Start workspace endpoint
`POST /start` validates project metadata and then:
- reuses the container if it is already running,
- starts it if it exists but is stopped,
- otherwise runs a fresh `my-code-server` container. 

### 3. Stop workspace endpoint
`POST /stop` removes a container with `docker rm -f`, but treats “already absent” as a successful no-op so cleanup converges safely.

### 4. Status endpoint
`POST /containerStatus` inspects Docker state and reports `running` or `stopped`.
### 5. Container naming convention
The default container name is `spinup-${projectId}`, which gives SpinUp a predictable handle for one-container-per-project behavior on the VM. 

## Why the agent does **not** need AWS credentials
The checked-in implementation does not call AWS APIs. It only:
- parses JSON,
- runs Docker CLI commands,
- returns HTTP responses. 

So this repo does **not** need S3, EC2, or ASG credentials to do its job. Its responsibility is strictly **local process/container management on the VM**.

That is very different from `vm-base-config`, whose startup scripts call S3 and therefore need AWS credentials from either:
- local environment variables during laptop-based Docker testing, or
- an EC2 instance profile role when running on AWS. The AWS SDK for JavaScript v3 uses a default credential provider chain in Node.js, and on EC2 it can retrieve temporary role credentials via the Instance Metadata Service when an instance profile is attached. 

## How to run it on a VM
The repo README is currently only the Bun scaffold (`bun install`, `bun run index.ts`). 

For SpinUp, the intended production shape is:

1. Install Docker on the VM.
2. Install Node and Bun.
3. Clone this repo onto the VM.
4. Run it under `systemd` so it starts on boot and restarts on failure.
5. Ensure the `my-code-server` image is already present or pullable.

`systemd` setup is a good fit for this architecture because it keeps the VM agent always on, while the workspaces themselves remain disposable containers.

## Example API shape

### Start a workspace
```bash
curl -X POST http://<vm-ip>:<agent-port>/start \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "123",
    "projectName": "test",
    "projectType": "nextjs"
  }'
```

### Stop a workspace
```bash
curl -X POST http://<vm-ip>:<agent-port>/stop \
  -H 'Content-Type: application/json' \
  -d '{
    "containerName": "spinup-123"
  }'
```

### Query status
```bash
curl -X POST http://<vm-ip>:<agent-port>/containerStatus \
  -H 'Content-Type: application/json' \
  -d '{
    "containerName": "spinup-123"
  }'
```

## Operational notes
- This agent assumes Docker is installed and the VM user can run Docker commands. 
- It assumes the workspace image is named `my-code-server`. 

## Summary
This repo is the **workspace control agent** for SpinUp. AWS is responsible for creating and scaling VMs; this agent is responsible for turning a live VM into a usable per-project code-server workspace host.
