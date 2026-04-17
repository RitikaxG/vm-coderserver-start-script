import { execFile } from "child_process";
import express from "express";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());

type StartBody = {
    projectId? : string,
    projectName? : string,
    projectType? : string,
    containerName? : string,
}

type StopBody = {
    containerName? : string;
}

type ContainerState = {
    isRunning? : boolean;
    Status? : string;
}

const isContainerMissingError = (err : unknown) => {
    const stderr =
    err && typeof err === "object" && "stderr" in err
      ? String((err as { stderr?: unknown }).stderr ?? "")
      : "";

    const message = err instanceof Error ? err.message : "";
    const combined = `${stderr} ${message}`.toLowerCase();

    return (
        combined.includes("no such object") ||
        combined.includes("no such container")
    )
};

const buildContainerName = (projectId: string, requestedName? : string ) => {
    const trimmed = requestedName?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : `spinup-${projectId}`;
};

const getContainerState = async(
    containerName : string,
): Promise<ContainerState | null> => {
    try{
        const { stdout } = await execFileAsync("docker",[
            "inspect",
            containerName,
            "--format",
            "{{json .State}}",
        ]);

        const trimmed = stdout.trim();
        if(!trimmed){
            return null;
        }

        return JSON.parse(trimmed) as ContainerState;
    } catch (err){
        if(isContainerMissingError(err)){
            return null;
        }
        throw err;
    }
};

const startExistingContainer = async(containerName : string) => {
    await execFileAsync("docker",["start",containerName]);
};

const runNewContainer = async ({
    containerName,
    projectId,
    projectName,
    projectType,
}:{
    containerName : string,
    projectId : string,
    projectName : string,
    projectType : string,
}) => {
    const { stdout } = await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    `PROJECT_ID=${projectId}`,
    "-e",
    `PROJECT_NAME=${projectName}`,
    "-e",
    `PROJECT_TYPE=${projectType}`,
    "-p",
    "8080:8080",
    "my-code-server",
  ]);

  return stdout.trim();
}

const removeContainerIfPresent = async(containerName : string) => {
    try{
        await execFileAsync("docker", ["rm", "-f", containerName]);
    } catch(err){
        if(isContainerMissingError(err)){
            return;
        }
        throw err;
    }
};

app.get("/health",(req,res) => {
    res.status(200).send("OK");
})

app.post("/start",async (req, res) => {
    const { projectId, projectName, projectType, containerName } : StartBody = req.body;

    if(!projectId || !projectName || !projectType){
        return res.status(400).json({
            message : "Missing project details"
        })
    }

    const finalContainerName = buildContainerName(projectId,containerName);

    try{
        const existingState = await getContainerState(finalContainerName);

        // Idempotent retry case 1: same container is already running
        if(existingState?.isRunning){
            return res.status(200).json({
                mesage : "Container already running",
                containerName : finalContainerName,
                reused : true,
            })
        };

        // Idempotent retry case 2: container exists but is stopped
        if(existingState && !existingState.isRunning){
            await startExistingContainer(finalContainerName);

            return res.status(200).json({
                message : "Existing container started",
                containerName : finalContainerName,
                reused : true,
            })
        }

        // Fresh create
        const containerId = await runNewContainer({
            containerName: finalContainerName,
            projectId,
            projectName,
            projectType,
        });

        return res.status(200).json({
            message : "Container created and started",
            containerId,
            containerName: finalContainerName,
            reused : false,
        })
    }catch(err){
        const message = err instanceof Error ? err.message : "Failed to start container";

        console.error(`Docker start error for ${finalContainerName}:`, message);

        return res.status(500).json({
            message : "Failed to start container",
            error : message,
            containerName : finalContainerName,
        })
    }
});

app.post("/stop",async (req,res) => {
    const { containerName } : StopBody = req.body;
    if(!containerName){
        return res.status(400).json({
            message : "Container name not provided"
        })
    }

    try{
        const existingState = await getContainerState(containerName);

        // Idempotent delete case 1: container already absent
        if(!existingState){
            return res.status(200).json({
                message : `Container ${containerName} already absent`,
                containerName,
            })
        }

        // rm -f is fine here because delete flow wants cleanup to converge
        await removeContainerIfPresent(containerName);

        return res.status(200).json({
            message : existingState.isRunning
            ? `Container ${containerName} stopped and removed successfully`
            : `Container ${containerName} was already stopped and is now removed`,
            containerName,
        })
    }catch(err){
        const message =
        err instanceof Error ? err.message : "Unknown stop error";

        console.error(`Error stopping container ${containerName}:`, message);

        return res.status(500).json({
            message: `Error stopping container ${containerName}`,
            error: message,
            containerName,
        });
    }
});

app.post("/containerStatus",async (req,res) => {
    const { containerName }: StopBody = req.body;

    if (!containerName) {
        return res.status(400).json({
        message: "Container name must be provided",
        });
    }

    try{
        const state = await getContainerState(containerName);

        if (!state || !state.isRunning) {
            return res.status(200).json({
                containerName,
                status: "stopped",
            });
        }

        return res.status(200).json({
            containerName,
            status: "running",
        });
    } catch (err) {
        const message =
        err instanceof Error ? err.message : "Unknown container status error";

        console.error(`Error checking status for container ${containerName}:`, message);

        return res.status(500).json({
            message: "Error checking container status",
            error: message,
            containerName,
        });
    }
})