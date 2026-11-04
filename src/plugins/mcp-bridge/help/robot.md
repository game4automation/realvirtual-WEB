# Robot workflow

Use `web_commands(query="ik.")` for argument schemas. Commands use the same validation
and undo route as the inspector. Author in the scene; close the asset editor first.
Inspect answers and resolve refusals before continuing. Replace the example paths with
paths returned by the preceding commands.

## Rig -> Path -> Targets -> Check -> Run -> Export

1. Rig an imported serial six-axis robot (the library CRX already ships rigged):
   `web_execute(command="ik.robot.rig", args={"path":"FanucCRX-10iA-L"})`.
   Inspect with `web_query(command="ik.robot.chain", args={"path":"FanucCRX-10iA-L"})`.
2. Create a path: `web_execute(command="ik.path.create", args={"robotPath":"FanucCRX-10iA-L","name":"Program1"})`.
3. Add targets at reachable world poses (metres, XYZ Euler degrees), or omit the pose
   to capture the current TCP:
   `web_execute(command="ik.target.add", args={"pathPath":"Program1","name":"Pick1"})`.
   Repeat for the next waypoints. Inspect with
   `web_query(command="ik.path.inspect", args={"pathPath":"Program1"})`.
4. Check before motion: `web_query(command="ik.path.check", args={"pathPath":"Program1"})`.
   Review reachability, stored-angle drift, near limits, singularity and each LIN
   segment's `runtimePrediction` (fixed dt and SpeedOverride). Checking moves nothing
   and consumes no live-solve slot. Without a solver, reachability is null.
5. Start simulation explicitly with `web_execute(command="sim.playPause", args={})`
   if paused. Then `web_execute(command="ik.path.run", args={"pathPath":"Program1","timeoutMs":120000})`.
   This returns a jobId. Poll `web_macro_status(jobId="<jobId>")` for the final report
   (`finished`, `reachedTargets`, `skipped`, LIN fallbacks and error).
   Cancel with `web_macro_cancel(jobId="<jobId>")`, or stop immediately with
   `web_execute(command="ik.path.stop", args={"pathPath":"Program1"})`.
   Stop is idempotent. Timeout cancels motion and reports the signal being waited on.
   Loop/linked paths report the first finished pass with `continues`; stop them explicitly.
6. Export: `web_execute(command="ik.program.export", args={"pathPath":"Program1","vendor":"abb-rapid","download":false})`.
   Review the returned copy-paste program template and warnings before controller use.

## TCP and grips

Jog live without creating a waypoint:
`web_execute(command="ik.robot.moveTcp", args={"path":"FanucCRX-10iA-L","deltaJson":"{\"position\":[0,0,0.05]}","frame":"world"})`.
`frame:"tool"` uses TCP axes; delta rotation is in degrees. Absolute moves use
positionJson (metres) and rotationJson (degrees), both in world coordinates. Use one
form at a time. An active path must be stopped first. Unreachable moves leave axes alone.

Set a waypoint's Grip reference:
`web_execute(command="ik.target.setGrip", args={"targetPath":"FanucCRX-10iA-L/Program1/Pick1","gripPath":"Tool/Grip"})`.
Use a Grip in the target's scope; a refusal lists candidates. `gripPath:null` clears it.
Enable the action with `web_execute(command="ik.target.set", args={"targetPath":"Pick1","fieldsJson":"{\"PickAndPlace\":true,\"Pick\":true}"})`.
A pre-existing fixer is preserved; gripTarget takes priority. setGrip is a recorded,
undoable edit. run/stop/moveTcp are transient simulation actions, without undo or recording.
Remove uses either `{targetPath}` or `{pathPath,index}` (raw IKPath.Path index,
including unresolved references); never combine the forms.

## Tier and limits

Every answer reports tier. Cobot live solving requires **pro**; stored-angle replay
works at every tier. Without a solver, authoring cannot invent angles. Read the refusal
and use the required tier rather than silently accepting an unreachable waypoint.

The check performs **no swept collision check** (`collision.checked:false`). It cannot
certify a collision-free trajectory. Unity's `AxisCorrection` is ignored by realvirtual WEB
(replay and program export alike); a non-zero value only produces a one-time console warning on export.
