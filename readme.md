# LC-3 Debugger

This is a VSCode debugger for LC-3, an educational computer system featured in Patt&Patel, the textbook. It is developed by (Steve) Haoxiang Lin of ZJU-UIUC institute.

This debugger is only an implementation of the debug adapter protocal, the runtime and assembler is written by [wChargin](https://github.com/wchargin/lc3web) in Javascript.

**This is an early beta version and is likely to have lots of bugs. For issues and bug reports, please go to the [GitHub issues page](https://github.com/TheJavaNoob/lc3debugger/issues)**

## Launching
* Go to your .asm file
* Switch to the debug viewlet and press the gear dropdown, VSCode will generate a default `launch.json` file for you. (You can replace the `${command:AskForProgramName}` with your file name that it doesn't ask you every time)
* Select the debug environment "LC-3 Debugger".
* Press the green 'play' button to start debugging.

## Features
### **Breakpoints and Stepping**
Standard debug functionalities such as breakpoints and stepping are supported, including step in, step out and step over.

### **Multiple .ORIG directives**
Unlike native lc3, the debugger supports multiple `.ORIG` directives in a single file.

      Note: Any `.ORIG` after the first one should only be used for data, since you can only set breakpoints for the first block, and labels in different blocks are not interaccessible and may even duplicate.

### **View Memory**
The disassembly view can be used to view the contents of memory and its corresponding instructions.

* The disassembly view automatically when the code starts running by default. 
* You can stop this by running `LC3Debugger: Toggle Auto Disassembly` in vscode command line. 
* You can also open the disassembly view manually in the right click menu.


### **View and Change Registers**
All registers, including PC is editable in the Variations panel.

### **Mark Variables**
Mark a label with `;@VARIABLE`, the corresponding memory address will be marked as a variable. You can view and edit them in the Variables view.

* A `.FILL` directive will be treated as a single variable.
* A `.BLKW` directive will be treated as an array.
* A variable can also be explicitly declared using `@VARIABLE:name:address:length`

### **Jump to Cursor**
Move the Program Counter to the cursor using the "Jump to Cursor" command in the right click menu.

* You can also move the PC in the variables panel in the right sidebar.

### **REPL Evaluation**
REPL-based runtime evaluations are supported.

* Run individual commands or view variable/register values in DEBUG CONSOLE
* Hover over variables/registers during runtime to check their value
* Turn on `Debugger: Inline Values` in settings to display variable/register values besides the code during execution.
