# LC-3 Debugger

This is a VSCode debugger for LC-3, an educational computer system featured in Patt&Patel, the textbook.

*Currently in development, you can pull the repo and build it yourself. It will be avaliable in VSCode marketplace once it's complete.*

The debugger implements the debug adapter protocal, the runtime and assembler is written by [wChargin](https://github.com/wchargin/lc3web) in Javascript.

## Launching
* Go to your .asm file
* Switch to the debug viewlet and press the gear dropdown, VSCode will generate a default `launch.json` file for you. (You can replace the `${command:AskForProgramName}` with your file name that it doesn't ask you every time)
* Select the debug environment "LC-3 Debugger".
* Press the green 'play' button to start debugging.

## Features
1. **Breakpoints and Stepping**

2. **View Memory**: The disassembly view automatically opens when the code starts running, you can open it in the right click menu. You can view the contents of memory and its corresponding instructions in the disassembly view.

3. **View and Change Registers**: All registers, including PC is changable.

4. **Mark Variables**: Mark a label with `;@VARIABLE`, the corresponding memory address will be marked as a variable. You can view and edit them in the Variables view.

5. **Call Stack**: *Work in progress*
