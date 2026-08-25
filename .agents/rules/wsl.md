---
trigger: always_on
---

The workspace runs natively inside WSL/Linux.

Project directory:
/home/jonakunze/projects/formbuilder/data

Use Linux/bash commands directly.
Do not invoke wsl.exe, powershell.exe, cmd.exe, or Windows paths.

Terminal execution rules:

1. Never use the Linux `timeout` command around short foreground commands
   such as docker restart, docker compose restart, git, npm, or test commands.

2. Prefer commands that produce a final explicit output line.

3. After every potentially quiet command, print a completion marker and exit code:

   <COMMAND>
   rc=$?
   printf '\n__COMMAND_FINISHED__ exit=%s\n' "$rc"
   exit "$rc"

4. When a command has visibly produced the completion marker, continue with
   the task immediately. Do not wait for further terminal output.

5. Do not start interactive or persistent foreground processes.
   Start servers and containers in detached mode.

6. For Docker operations, execute the action and then verify the resulting
   state with a separate Docker inspect or docker compose ps command.

7. If the terminal integration still reports that a completed command is
   running, stop waiting and verify the result using a new terminal command.