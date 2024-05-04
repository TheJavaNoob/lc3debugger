import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, OutputEvent, InvalidatedEvent, StoppedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, MemoryEvent, Variable
} from '@vscode/debugadapter';

import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { Subject } from 'await-notify';
import { LC3 } from './lc3_core';
import { assemble, commands, tokenizeLine, encodeInstruction } from './lc3_as.js';
import * as vscode from 'vscode';
import * as base64 from 'base64-js';

export interface FileAccessor {
	isWindows: boolean;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export class Register {
	public set value(value: number) {
		this._value = value;
	}
	public get value() {
		return this._value;
	}
	constructor(public readonly id: number, private _value: number) { }
}

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
}

interface IAttachRequestArguments extends ILaunchRequestArguments { }

interface AssemblyResult {
	orig: number;
	symbolTable: Map<string, number>;
	machineCode: number[];
	error: string[];
	lineNumbers: number[];
}

interface StaticArrayVariable {
	address: number;
	values: number[];
	variablesReference: number;
}

export class LC3DebugSession extends LoggingDebugSession {
	// 
	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// a Mock runtime (or debugger)

	// A handle is basically a map with auto-generated keys. The key is the variable reference, and the value is either
	// the type of variable or an array to generate child variables in variablesRequest.
	private _variableHandles = new Handles<'registers' | 'variables' | StaticArrayVariable>();

	private _valuesInHex = true;
	private _useInvalidatedEvent = false;

	private _addressesInHex = true;

	// If in batch mode, the subroutine level at which to exit.
	private target = -1;

	// Unlike stock lc3, we can have multiple .ORIG directives in a single file, but we can only set breakpoints
	// for the first one. However, labels in different blocks are not interaccessible and may even duplicate.
	private assemblyResults: AssemblyResult[];

	private lc3;

	private programPath = '';
	private userCode = '';

	// Used for the breakpointsRequest.
	private breakpointID = 0;

	private fileAssessor: FileAccessor;

	// Used for the goto request.
	private gotoTargetAddresses: number[] = [];

	private isWaitingIO = false;

	/*
	 * Array of the addresses with breakpoints assigned.
	 */
	private breakpointAddresses: number[] = [];
	private instructionBreakpointAddresses: number[] = [];

	private _configurationDone = new Subject();
	/*
	* Array of the addresses where the program counter has been.
	* used for finding line number in case pc enters os territory.
	*/
	private pcTrace: number[] = [];

	// True when the user pauses the program.
	private isPaused = false;

	private isDisassemblingOnStartup = false;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("mock-debug.txt");
		this.lc3 = new LC3();
		this.fileAssessor = fileAccessor;
		this.assemblyResults = [];

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	 * The 'initialize' request is the first request called by the frontend before attatch or launch
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		response.body.supportsStepBack = false;
		
		response.body.supportsDataBreakpoints = false;

		response.body.supportsCompletionsRequest = false;

		response.body.supportsCancelRequest = false;

		response.body.supportsBreakpointLocationsRequest = true;

		response.body.supportsStepInTargetsRequest = false;

		response.body.supportsGotoTargetsRequest = true;

		// This is assembly, there's no such thing as an exception.
		response.body.supportsExceptionFilterOptions = false;
		response.body.supportsExceptionInfoRequest = false;

		response.body.supportsSetVariable = true;

		// make VS Code send setExpression request
		response.body.supportsSetExpression = false;

		// Disassembly are used as a way to display memory, since we are already working with assembly.
		// Normal breakpoints are sufficient, so instruction breakpoints are not supported.
		response.body.supportsDisassembleRequest = true;
		response.body.supportsSteppingGranularity = false;
		response.body.supportsInstructionBreakpoints = false;

		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;

		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsDelayedStackTraceLoading = false;

		this.sendResponse(response);
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);
		// notify the configurationDonePromise that configuration (breakpoints etc.) has finished, 
		// therefore launch can continue.
		this._configurationDone.notify();
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(LC3DebugSession.threadID, "Main thread"),
			]
		};
		this.sendResponse(response);
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
		return this.launchRequest(response, args);
	}

	/*
	* The entry point of the debugger, called by VS Code when the user clicks on 'Start Debugging'.
	* The process is as follows:
	* 1. Read the file and assemble the code.
	* 2. Send the InitializedEvent, after which the frontend will send initialization requests such as setBreakPointsRequest.
	* 3. After the initialization requests are done, the configurationDoneRequest will be called, where the
	* 	_configurationDone promise will be notified, and the program will start running.
	*/
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(Logger.LogLevel.Verbose, false);
		this.programPath = args.program;
		let userCodeBytes = await this.fileAssessor.readFile(args.program);
		this.userCode = new TextDecoder().decode(userCodeBytes);
		const splitUserCode = this.userCode.split('.END');
		var startLine = 0;
		splitUserCode.slice(0, splitUserCode.length - 1).forEach((block, i) => {
			//if (block)
			block = block + '.END';
			const assembleResult: AssemblyResult = assemble(block);
			// Line numbers in the array are 0-indexed.
			assembleResult.lineNumbers = assembleResult.lineNumbers.map((line) => line + startLine);
			// We add one to account for the missing .END directive.
			startLine += block.split('\n').length + 1;
			this.assemblyResults.push(assembleResult);
			if (this.assemblyResults[i] === undefined) { return; }
			if (this.assemblyResults[i].error) {
				var errorList = this.assemblyResults[i].error;
				var cardinal = (i + 1) + "th";
				if (i <= 2){
					cardinal = ['1st', '2nd', '3rd'][i];
				}
				this.sendErrorResponse(response, {
					id: 1001,
					format: `Assembly failed at the ${cardinal} code block: ${errorList.join('\n')}`,
					showUser: true
				});
				return;
			}
			this.lc3.loadAssembled(this.assemblyResults[i]);
		});
		this.lc3.pc = this.assemblyResults[0].orig;
		this.lc3.addListener( (message) => {
			if(message.type === 'exception'){
				// There are only two types of exceptions in LC-3, invalid opcode and invalid memory access.
				this.sendEvent(new StoppedEvent('exception', LC3DebugSession.threadID));
			}else if(message.type === 'keyout'){
				const key = String.fromCharCode(message.value);
				this.sendEvent(new OutputEvent(key, 'stdout'));
			}
		});
		// The code is assembled, we are ready to accept configurations (breakpoints, etc.)
		// This will call setBreakPointsRequest, after which configurationDoneRequest will be called.
		this.sendEvent(new InitializedEvent());
		// Wait 0 seconds after configuration (breakpoints, etc.) has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(0);
		this.target = -Infinity;
		await this.enterBatchMode();
		// Opens the disassembly view when the program stops for the first time.
		if (this.isDisassemblingOnStartup) {
			vscode.commands.executeCommand('debug.action.openDisassemblyView');
		}
		this.sendResponse(response);
	}

	private async enterBatchMode(isRecoveredFromBreakpoint: boolean = false) {
		var done = false;
		// Clear the pcTrace every time we enter batch mode, so that it doesn't grow indefinitely.
		this.pcTrace = [];

		// Also, don't run at all if the LC-3 is halted.
		if (!this.lc3.isRunning()) {
			this.sendEvent(new StoppedEvent('halted', LC3DebugSession.threadID));
			return;
		}

		while (!done) {
			var op = this.lc3.nextInstruction();
			this.pcTrace.push(this.lc3.pc);
			// Go to the next instruction if we're recovering from a breakpoint.
			// Check if we've hit a breakpoint
			if (this.breakpointAddresses.includes(this.lc3.pc) || this.instructionBreakpointAddresses.includes(this.lc3.pc)) {
				done = true;
				this.sendEvent(new StoppedEvent('breakpoint', LC3DebugSession.threadID));
			}
			if (this.lc3.subroutineLevel <= this.target) {
				// we've returned from the target subroutine
				done = true;
				this.sendEvent(new StoppedEvent('step', LC3DebugSession.threadID));
			}
			if (!this.lc3.isRunning()) {
				// we've halted
				done = true;
				this.sendEvent(new StoppedEvent('halt', LC3DebugSession.threadID));
			}
			if(this.isPaused){
				// The user has paused the program.
				done = true;
			}
			if(op.isIO){
				// We've hit an IO operation, continuously wait 5ms until io is done.
				// If io is not done (i.e. user did not input), nextInstruction will
				// return the same io instruction.
				this.isWaitingIO = true;
				await new Promise(resolve => setTimeout(resolve, 5));
				this.isWaitingIO = false;
			}
		}
		this.isPaused = false;
	}


	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		
	}

	/*
	* Run the program forever
	* aka "Run" in LC3 Web
	* -1 isn't good enough:
	* if there are more RETs than JSR/JSRR/TRAPs,
	* which can happen if the PC is modified manually
	* or execution flows into a subroutine,
	* then the subroutine level can be negative.
	* But it can't be less than -Infinity!
	* (at least, it would take a while)
	*/
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.target = -Infinity;
		this.enterBatchMode(true);
		this.sendResponse(response);
	}

	/**
	 * Step to the next/previous non empty instruction, skipping subroutines.
	 * aka step over.
	 * aka "Next" in LC3 Web
	 */
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.target = this.lc3.subroutineLevel;
		this.enterBatchMode(true);
		this.sendResponse(response);
	}

	/**
	 * Step forward and go into a subroutine if necessary.
	 * aka "Step" in LC3 Web
	 */
	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		// Refuse to step in if the LC3 is halted.
		if (!this.lc3.isRunning()) {
			this.sendEvent(new StoppedEvent('halted', LC3DebugSession.threadID));
			return;
		}
		this.lc3.nextInstruction();
		this.pcTrace.push(this.lc3.pc);
		this.sendEvent(new StoppedEvent('step', LC3DebugSession.threadID));
		this.sendResponse(response);
	}

	/**
	 * Keep going until we go one level up.
	 * aka "Finish" in LC3 web
	 */
	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.target = this.lc3.subroutineLevel - 1;
		this.enterBatchMode(true);
		this.sendResponse(response);
	}

	/**
	 * Pause the program.
	 */
	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.isPaused = true;
		this.sendResponse(response);
	}

	protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request | undefined): void {
		const address = this.getAddressFromLine(args.line);
		if (address < this.assemblyResults[0].orig || address >= this.lc3.memory.length) {
			response.body = {
				targets: []
			};
			this.sendResponse(response);
		}
		this.gotoTargetAddresses.push(address);
		response.body = {
			targets: [{
				id: this.gotoTargetAddresses.length - 1,
				label: this.format16BitHex(address),
				line: this.getLineFromAddress(address)
			}]
		};
		this.sendResponse(response);
	}

	protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments, request?: DebugProtocol.Request | undefined): void {
		if(args.targetId !== undefined && args.targetId < this.gotoTargetAddresses.length) { 
			this.lc3.pc = this.gotoTargetAddresses[args.targetId];
			this.gotoTargetAddresses.splice(args.targetId, 1);
			this.sendEvent(new StoppedEvent('goto', LC3DebugSession.threadID));
			this.sendResponse(response);
			return;
		}
	}

	/*
	* Called when the user clicks "pause".
	* Returns the stack trace at the current pc, used to tell the editor the current line.
	* Currently the stack trace is just the current line. May implement actual stack frames in the future.
	*/
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const arrayStackFrames = new Array<StackFrame>();
		var line = this.getLineFromAddress(this.lc3.pc);
		var name = 'line ' + line;
		if (line === -1) {
			line = 0;
			name = "Running into data";
			return;
		}
		const stackFrame: DebugProtocol.StackFrame = new StackFrame(0, name, this.createSource(), line);
		stackFrame.instructionPointerReference = this.format16BitHex(this.lc3.pc);
		arrayStackFrames.push(stackFrame);
		response.body = {
			stackFrames: arrayStackFrames,
			totalFrames: arrayStackFrames.length
		};
		this.sendResponse(response);
	}

	/* 
	* Called immediately after attachRequest.
	* 
	*/
	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		const path = args.source.path as string;
		if (path !== this.programPath) {
			this.sendResponse(response);
			return;
		}
		const clientLines = args.lines || [];

		// set and verify breakpoint locations
		this.breakpointAddresses = [];
		const actualBreakpoints = clientLines.map(line => {
			let address = this.getAddressFromLine(line);
			if (address === -1) {
				return new Breakpoint(false, line) as DebugProtocol.Breakpoint;
			}
			const bp = new Breakpoint(true, line) as DebugProtocol.Breakpoint;
			bp.id = this.breakpointID++;
			this.breakpointAddresses.push(address);
			return bp;
		});
		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	/*
	* Returns all breakpoint-able lines. Regardless of start and eng line requirements?
	* Breakpoints only support the first block of code.
	*/
	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		if (args.source.path) {
			response.body = {
				// assembly line number starts at 0, client line number starts at 1
				breakpoints: this.assemblyResults[0].lineNumbers.map(line => {
					return {
						line: line + 1,
						column: 0
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		// the only scope is registers
		response.body = {
			scopes: [
				new Scope("Registers", this._variableHandles.create('registers'), false),
				new Scope("Variables", this._variableHandles.create('variables'), false)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		const handleResult = this._variableHandles.get(args.variablesReference);
		if (handleResult === 'registers') {
			var registers: DebugProtocol.Variable[] = this.lc3.r.map((r, i) => {
				return {
					name: "R" + i,
					value: this.formatNumber(r),
					// Not a parent variable
					variablesReference: 0
				};
			});
			const pc = {
				name: "PC",
				value: this.formatNumber(this.lc3.pc),
				variablesReference: 0
			};
			registers = [pc, ...registers];
			response.body = {
				variables: registers
			};
		} else if (handleResult === 'variables') {
			var variables = this.findVariables();
			response.body = {
				variables: variables
			};
		} else if (handleResult && Array.isArray(handleResult.values)) {
			// This is a parent variable
			response.body = {
				variables: handleResult.values.map((v, i) => {
					return {
						name: i.toString(),
						value: this.formatNumber(v),
						memoryReference: (handleResult.address + i).toString(),
						variablesReference: 0
					};
				})
			};
		}
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		const variableType = this._variableHandles.get(args.variablesReference);
		if (variableType === "registers") {
			if (args.name === "PC") {
				this.lc3.pc = this.parseLC3Number(args.value);
				response.body = new Variable(args.name, args.value, 0);
			} else if (args.name.startsWith("R")){
				const registerID = parseInt(args.name.slice(1));
				this.lc3.r[registerID] = this.parseLC3Number(args.value);
				response.body = new Variable(args.name, args.value, 0);
			}
		}
		if (variableType === "variables") {
			const variable = this.findVariables().find(v => v.name === args.name);
			if (variable) {
				variable.value = args.value;
				this.lc3.memory[variable.memoryReference!] = parseInt(args.value);
				response.body = variable;
			}
			this.sendEvent(new MemoryEvent(String(variable?.memoryReference), 0, variable?.value.length! * 2));
		}
		this.sendResponse(response);
	}

	/*
	* Writes the value of a variable.
	*/
	protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments) {
		var startingAddress = parseInt(memoryReference) + offset / 2;
		var byteArray = base64.toByteArray(data);
		const writeLength = byteArray.length;
		if (offset % 2 !== 0) {
			startingAddress -= 0.5;
			// If offset is odd, write to the low bits of the memory, then shift the byteArray.
			this.lc3.memory[startingAddress] = (this.lc3.memory[startingAddress] & 0xFF00) | byteArray[0];
			startingAddress++;
			byteArray = byteArray.slice(1);
		}
		// Convert byte array to 16-bit memory
		for (let i = 0; i < byteArray.length ; i += 2) {
			const highByte = byteArray[i];
			const lowByte = byteArray[i + 1];
			this.lc3.memory[startingAddress + i / 2] = (highByte << 8) | lowByte;
		}
		response.body = {
			bytesWritten: writeLength
		};
		this.sendResponse(response);
		this.sendEvent(new InvalidatedEvent(['variables']));
	}

	protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments) {
		// Memory reference should be a decimal number
		const maxMemoryAddress = 0xFFFF;
		// Since offset is in bytes but memory is 16-bit, divide by 2
		// If offset happen to be odd (attempt to read from the low bits), it is rounded down.
		// In this case we will force to read from the high bits, adding 1 to unreadableBytes.
		const startingAddress = parseInt(memoryReference) + offset / 2;
		const memory = this.lc3.memory.slice(
			Math.min(startingAddress, maxMemoryAddress),
			Math.min(startingAddress + count / 2,  maxMemoryAddress),
		);
		// Convert 16-bit memory to byte array
		var byteArray: number[] = [];
		for (let i = 0; i < memory.length; i++) {
			const highByte = (memory[i] & 0xFF00) >> 8;
			const lowByte = memory[i] & 0x00FF;
			byteArray.push(highByte, lowByte);
		}
		response.body = {
			address: this.format16BitHex(startingAddress),
			data: base64.fromByteArray(new Uint8Array(byteArray)),
			unreadableBytes: count - memory.length
		};
		this.sendResponse(response);
	}

	private formatNumber(x: number): string {
		return this._valuesInHex ? '0x' + x.toString(16) : x.toString(10);
	}

	/*
	* Evaluates the given expression.
	* This doubles as a way to input characters into the LC-3.
	* Also note that debug hover and inline variables use this request for some reason, so
	* these two functions are not separately implemented.
	*/
	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		try{
			// If currently waiting for IO
			if (this.isWaitingIO) {
				var key = "";
				// If the expression is empty, send a newline. Otherwise a newline should'n be appended.
				// Unless the user explicitly added a newline at the end.
				if(args.expression === ""){
					key = "\n";
				}
				// sendKey accepts the ascii code of the key.
				key.split('').forEach((char) => {
					this.lc3.sendKey(char.charCodeAt(0));
				});
				response.body = {
					result: "Input buffer has " + this.lc3.bufferedKeys.length + " character(s). Clear using 'clear' command.",
					variablesReference: 0
				};
				this.sendResponse(response);
				return;
			}
			// If the expression is a command.
			if (args.expression === 'clear') {
				this.lc3.clearBufferedKeys();
				response.body = {
					result: "Input buffer cleared.",
					variablesReference: 0
				};
				this.sendResponse(response);
				return;
			}
			// If the expression is a memory address.
			if (args.expression.toUpperCase() === 'PC') {
				response.body = {
					result: this.formatNumber(this.lc3.pc),
					variablesReference: 0
				};
				this.sendResponse(response);
				return;
			}
			// If the expression is a register.
			if (args.expression.toUpperCase().startsWith('R')) {
				const registerID = parseInt(args.expression.slice(1));
				response.body = {
					result: this.formatNumber(this.lc3.r[registerID]),
					variablesReference: 0
				};
				this.sendResponse(response);
				return;
			}
			// If the expression is a variable.
			const variable = this.findVariables().find(v => v.name === args.expression);
			if (variable) {
				response.body = {
					result: variable.value,
					variablesReference: variable.variablesReference
				};
				this.sendResponse(response);
				return;
			}
			args.expression.split("\n").forEach((line) => {
				const tokenizedLine = tokenizeLine(line.trim(), 0);
				try{
					const machineCode = encodeInstruction(tokenizedLine);
					const op = this.lc3.decode(machineCode);
					const address = this.lc3.evaluateAddress(this.lc3.pc, op);
					const operand = this.lc3.fetchOperands(address);
					const result = this.lc3.execute(op, address, operand);
					this.lc3.storeResult(op, result);
				} catch (e) {
					if (e instanceof Error){
						response.body = {
							result: e.message,
							variablesReference: 0
						};
					}
					this.sendResponse(response);
					return;
				}
			});
			this.sendResponse(response);
		}catch(e){
			console.log(args.expression);
			console.log(e);
		}
	}

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {
		this.sendResponse(response);
	}

	protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {
		// Formatting is in principal always hex, preserved redundant code for future use.
		// memoryReference should be decimal, but it's fine since parseInt will figure it out.
		const memoryInt = args.memoryReference;
		const offset = args.instructionOffset || 0;
		const startAddress = parseInt(memoryInt) + offset;
		const count = args.instructionCount;
		const loc = this.createSource();
		const instructions: DebugProtocol.DisassembledInstruction[] = [];
		for (let address = startAddress; address < startAddress + count; address++) {
			var instr: DebugProtocol.DisassembledInstruction = {
				address: this.format16BitHex(address),
				instruction: '???',
				location: loc,
				line: -1
			};
			if (address < 0 || address >= this.lc3.memory.length) {
				instructions.push(instr);
				continue;
			}

			instr.instructionBytes = this.format16BitHex(this.lc3.memory[address]);
			// entry is a tuple of the symbol and the address
			const entryArray = this.assemblyResults.map((result) => {
				return Object.entries(result.symbolTable).find(([key, value]) => value === address);
			});
			const entry = entryArray?.find((entry) => entry !== undefined);
			
			if (entry) {
				instr.symbol = entry[0];
				instr.instructionBytes += "    " + entry[0];
			}
			instr.instruction = this.lc3.instructionToString(address, this.lc3.memory[address]);
			instr.line = this.getLineFromAddress(address);
			if (address >= 0x3000 && address < 0x3010) {
				// for debug
			}
			instructions.push(instr);
		}
		response.body = {
			instructions: instructions
		};
		this.sendResponse(response);
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		if (command === 'toggleFormatting') {
			this._valuesInHex = !this._valuesInHex;
			if (this._useInvalidatedEvent) {
				this.sendEvent(new InvalidatedEvent(['variables']));
			}
			this.sendResponse(response);
		} else if (command === 'toggleDisassembly') {
			this.isDisassemblingOnStartup = !this.isDisassemblingOnStartup;
			this.sendResponse(response);
		} else{
			super.customRequest(command, response, args);
		}
	}

	//---- helpers
	/*
	* Find variables marked by the user using "@VARIABLE" in the assembly code.
	* There are a few types of variables:
	* 1. A single variable, which is just a label followed by .FILL or .BLKW #1
	* 2. An array, which is a label followed by .BLKW #n
	* 3. A declaration marked as @VARIABLE:name:address:length, if length is missing, it's a dynamic array,
	*   which can only be viewed in memory view.
	*/
	private findVariables(): DebugProtocol.Variable[] {
		const variables: DebugProtocol.Variable[] = [];
		var userLines = this.userCode.split('\n');
		userLines.forEach((line, i) => {
			if (line.replace(' ', '') === ';@VARIABLE') {
				// The next line should start with a label, which we will use as the variable name.
				// If it is empty, we will just use the line number.

				var nextLine = userLines[i + 1].trim().split(';')[0];
				var name: string;
				var nextCommand: string;
				if (commands.includes(nextLine.split(' ')[0])) {return;}
				if (nextLine.split(' ').length > 1) {
					// If the lable and other stuff is on the same line.
					name = nextLine.split(' ')[0];
					nextCommand = nextLine.slice(name.length).trim();
				} else {
					name = (nextLine !== '' ? nextLine : i.toString());
					nextCommand = userLines[i + 2];
				}

				// Memory reference is the address of the variable aka the label.
				const memoryReference:number = this.assemblyResults.map( (result) => {
					return result.symbolTable[name];
				}).find((address) => address !== undefined);

				if (memoryReference === undefined) {
					return;
				}
				// The line after that may be a .BLKW directive, which we will use to determine the length of 
				// the variable, otherwise we will assume it is 1.
				// If the length is more than 1, we will create a parent variable with a new variable reference.
				// Then create children variables referencing the parent variable.
				var length = 1;
				if (nextCommand.startsWith('.BLKW') && nextCommand.split(' ').length > 1){
					length = this.parseLC3Number(nextCommand.split(' ')[1]);
				}
				let value = this.lc3.memory[memoryReference];
				const variable: DebugProtocol.Variable = {
					name: name,
					value: this.formatNumber(value),
					variablesReference: 0,
					memoryReference: memoryReference.toString(),
				};
				if (length > 1) {
					// Since the code passed assembly, we won't check the validity of memoryReference.
					const staticArrayVariable: StaticArrayVariable = {
						values: this.lc3.memory.slice(memoryReference, memoryReference + length),
						variablesReference: 0,
						address: memoryReference
					};
					const arrayVariableReference = this._variableHandles.create(staticArrayVariable);
					staticArrayVariable.variablesReference = arrayVariableReference;
					// This is now a parent variable. We will store a reference to StaticArrayVariable as the 
					// variable reference, and the children will be generated in variablesRequest.
					variable.value = 'Array[' + length + ']';
					variable.variablesReference = arrayVariableReference;
				}
				
				// .FILL and other invalid stuff are stored as binary.
				variables.push(variable);
			} else if (line.replace(' ', '').startsWith(";@VARIABLE:")){
				if(line.split(':').length < 3) {return;}
				var name = line.split(':')[1];
				var address = this.parseLC3Number(line.split(':')[2]);
				// A dynamic array by default, the value can only be viewed in memory view.
				const variable: DebugProtocol.Variable = {
					name: name + '(' + this.format16BitHex(address) + ')',
					value: '(View in memory ->)',
					variablesReference: 0,
					presentationHint: { kind: 'data', attributes: ['readOnly'] },
					memoryReference: address.toString(),
				};
				if (line.split(':').length > 3) {
					length = this.parseLC3Number(line.split(':')[3]);
					if (length > 1) {
						const staticArrayVariable: StaticArrayVariable = {
							values: this.lc3.memory.slice(address, address + length),
							variablesReference: 0,
							address: address
						};
						const arrayVariableReference = this._variableHandles.create(staticArrayVariable);
						staticArrayVariable.variablesReference = arrayVariableReference;
						variable.value = 'Array[' + length + ']';
						variable.variablesReference = arrayVariableReference;
					} else {
						variable.value = this.formatNumber(this.lc3.memory[address]);
					}
				}
				variables.push(variable);
			}
		});
		return variables;
	}

	private parseLC3Number(x: string): number {
		if (x.startsWith('x')) {
			x = '0' + x;
		}
		if (x.startsWith('#')) {
			x = x.slice(1);
		}
		return parseInt(x);
	}

	private format16BitHex(x: number, pad = 4) {
		return this._addressesInHex ? '0x' + x.toString(16).padStart(4, '0').toUpperCase() : x.toString(10);
	}

	private createSource(): Source {
		return new Source(basename(this.programPath), this.programPath, undefined, undefined, 'lc3');
	}

	/*
	* Returns the address of the machine code that corresponds to the line in the assembly code.
	*/
	private getAddressFromLine(clientLine: number): number {
		// Parameter line starts at 1, assemblyResult lineNumbers starts at 0
		var tempLineNum = this.assemblyResults.map((result, i) => {
			return result.lineNumbers.findIndex((machineCodeLine) => machineCodeLine === clientLine - 1) + this.assemblyResults[i].orig || 0;
		}).find((address) => address !== -1);

		if (tempLineNum === undefined) {
			return -1;
		}
		return tempLineNum! || 0;
	}

	private getLineFromAddress(address: number): number {
		var tempLineNum = this.getLineFromNonOSAddress(address);
		if (tempLineNum !== -1) {
			return tempLineNum;
		}
		var searchIndex = this.pcTrace.length - 1;
		while (searchIndex >= 0) {
			// If in os territory, we need to go back the pcTrace to find the line number.
			const tempLineNum = this.getLineFromNonOSAddress(this.pcTrace[searchIndex]);
			if (tempLineNum !== -1) {
				return tempLineNum;
			}
			searchIndex--;
		}
		return -1;
	}

	// Returns the line number of the address in the non-OS territory of the assembly code.
	private getLineFromNonOSAddress(address: number): number {
		var addressIndex = 0;
		for ( var result of this.assemblyResults) {
			addressIndex = address - result.orig;
			if (addressIndex >= 0 && addressIndex < result.lineNumbers.length) {
				return result!.lineNumbers[addressIndex] + 1;
			}
		}
		return -1;
	}

}

