import express from "express";
import { exec } from "child_process";
import { stderr, stdout } from "process";

const app = express();
app.use(express.json());

app.post("/start",(req,res) => {
    const { projectId, projectName, projectType } = req.body;
    
    const conatinerName = `container-${projectId}_${projectName}`;

    if(!projectId || !projectName || !projectType){
        res.status(400).json({
            message : `Missing project details`
        })
    }
    const dockerCmd = `docker run -d \
    --name ${conatinerName} \
    -e PROJECT_ID=${projectId} \
    -e PROJECT_NAME=${projectName} \
    -e PROJECT_TYPE=${projectType} \
    -p 8080:8080 \
    my-code-server`;

    // Run Docker Command
    exec(dockerCmd, (err, stdout, stderr) => {
        if(err){
            console.error(`Docker error`,stderr);
            return res.status(500).json({
                message : `Failed to start conatiner`
            })
        }
       
        return res.status(200).json({ message: 'Container started', containerId: stdout.trim(), conatinerName : conatinerName });
    })
})

app.post("/stop", (req, res ) => {
    const { containerName } = req.body;
    if(!containerName){
        return res.status(400).json({
            message : `Container name not provided`
        })
    }

    const stopCommand = `docker kill ${containerName} || true && docker rm -f ${containerName}`;

    exec(stopCommand,(err,stdout,stderr) => {
        if(err){
            console.error(`Error stopping container ${containerName}`);
            return res.status(500).json({
                message : `Error stopping container ${containerName} ${err.message}`
            })
        }
        return res.status(200).json({
            message : `Container ${containerName} stopped successfully`
        })

    })
})

app.listen(3000,()=>{
    console.log("Listening on port 3000");
})