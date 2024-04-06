/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * mockDebug.ts implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger" (here: class MockRuntime).
 * When implementing your own debugger extension for VS Code, most of the work will go into the Debug Adapter.
 * Since the Debug Adapter is independent from VS Code, it can be used in any client (IDE) supporting the Debug Adapter Protocol.
 *
 * The most important class of the Debug Adapter is the MockDebugSession which implements many DAP requests by talking to the MockRuntime.
 */

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, MemoryEvent, Variable
} from '@vscode/debugadapter';

import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { Subject } from 'await-notify';
import { LC3 } from './lc3_core';
import { assemble, commands } from './lc3_as.js';
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

interface DynamicArrayVariable {
	address: number;
	length: number;
	variablesReference: number;
}

export class MockDebugSession extends LoggingDebugSession {
	// 
	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// a Mock runtime (or debugger)

	// A handle is basically a map with auto-generated keys. The key is the variable reference, and the value is either
	// the type of variable or an array to generate child variables in variablesRequest.
	private _variableHandles = new Handles<'registers' | 'variables' | StaticArrayVariable>();

	// a map of all running requests
	private _cancellationTokens = new Map<number, boolean>();

	private _reportProgress = false;
	private _progressId = 10000;
	private _cancelledProgressId: string | undefined = undefined;
	private _isProgressCancellable = true;

	private _valuesInHex = true;
	private _useInvalidatedEvent = false;

	private _addressesInHex = true;

	// If in batch mode, the subroutine level at which to exit.
	private target = -1;

	private assemblyResult: AssemblyResult | undefined;

	private lc3;

	private batchMode = false;

	private programPath = '';
	private userCode = '';

	private breakpointID = 0;

	private fileAssessor: FileAccessor;


	/*
	 * Array of the addresses with breakpoints assigned.
	 */
	private breakpointAddresses: number[] = [];
	private breakpointLines = [];

	private _configurationDone = new Subject();
	/*
	* Array of the addresses where the program counter has been.
	* used for finding line number in case pc enters os territory.
	*/
	private pcTrace: number[] = [];

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("mock-debug.txt");
		this.lc3 = new LC3();
		this.fileAssessor = fileAccessor;

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
		/*
		this._runtime = new MockRuntime(fileAccessor);

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', MockDebugSession.threadID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.threadID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', MockDebugSession.threadID));
		});

		this._runtime.on('stopOnInstructionBreakpoint', () => {
			this.sendEvent(new StoppedEvent('instruction breakpoint', MockDebugSession.threadID));
		});

		this._runtime.on('stopOnException', (exception) => {
			if (exception) {
				this.sendEvent(new StoppedEvent(`exception(${exception})`, MockDebugSession.threadID));
			} else {
				this.sendEvent(new StoppedEvent('exception', MockDebugSession.threadID));
			}
		});

		this._runtime.on('breakpointValidated', (bp: IRuntimeBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});

		*/
	}

	/**
	 * The 'initialize' request is the first request called by the frontend before attatch or launch
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		if (args.supportsProgressReporting) {
			this._reportProgress = true;
		}
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = false;

		// make VS Code show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code support completion in REPL
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [".", "["];

		// make VS Code send cancel request
		response.body.supportsCancelRequest = false;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// do not provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = false;

		// the adapter defines two exceptions filters, one with support for conditions.
		response.body.supportsExceptionFilterOptions = false;

		// make VS Code send exceptionInfo request
		response.body.supportsExceptionInfoRequest = false;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

		// make VS Code send setExpression request
		response.body.supportsSetExpression = false;

		// make VS Code send disassemble request
		response.body.supportsDisassembleRequest = true;
		response.body.supportsSteppingGranularity = true;
		response.body.supportsInstructionBreakpoints = true;

		// make VS Code able to read and write variable memory
		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;
		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsDelayedStackTraceLoading = false;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
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
				new Thread(MockDebugSession.threadID, "Main thread"),
			]
		};
		this.sendResponse(response);
	}

	private output(category: string, text: string, filePath?: string, line?: number, column?: number) {
		const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, category);

		if (text === 'start' || text === 'startCollapsed' || text === 'end') {
			e.body.group = text;
			e.body.output = `group-${text}\n`;
		}

		if (filePath) {
			e.body.source = this.createSource();
		}
		if (line) {
			e.body.line = this.convertDebuggerLineToClient(line);
		}
		if (column) {
			e.body.column = this.convertDebuggerColumnToClient(column);
		}
		this.sendEvent(e);
	}



	protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
		return this.launchRequest(response, args);
	}

	/*
	* Called by VS Code when the user clicks on 'Start Debugging'.
	*/
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(Logger.LogLevel.Verbose, false);
		this.programPath = args.program;
		let userCodeBytes = await this.fileAssessor.readFile(args.program);
		this.userCode = new TextDecoder().decode(userCodeBytes);
		this.assemblyResult = assemble(this.userCode);
		if (this.assemblyResult === undefined) { return; }
		if (this.assemblyResult.error) {
			var errorList = this.assemblyResult.error;
			this.sendErrorResponse(response, {
				id: 1001,
				format: `Assembly failed: ${errorList.join('\n')}`,
				showUser: true
			});
			return;
		}
		this.lc3.loadAssembled(this.assemblyResult);
		// The code is assembled, we are ready to accept configurations (breakpoints, etc.)
		// This will call setBreakPointsRequest, after which configurationDoneRequest will be called.
		this.sendEvent(new InitializedEvent());
		// Wait 0 seconds after configuration (breakpoints, etc.) has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(0);
		this.target = -Infinity;
		await this.enterBatchMode();
		// Opens the disassembly view when the program stops for the first time.
		vscode.commands.executeCommand('debug.action.openDisassemblyView');
		this.sendResponse(response);
	}

	private async enterBatchMode(isRecoveredFromBreakpoint: boolean = false) {
		this.batchMode = true;
		var done = false;

		// Also, don't run at all if the LC-3 is halted.
		if (!this.lc3.isRunning()) {
			this.sendEvent(new StoppedEvent('halted', MockDebugSession.threadID));
			return;
		}

		while (!done) {
			// Go to the next instruction if we're recovering from a breakpoint.
			if (isRecoveredFromBreakpoint) {
				var op = this.lc3.nextInstruction();
				this.pcTrace.push(this.lc3.pc);
			}
			// Check if we've hit a breakpoint
			if (this.breakpointAddresses.includes(this.lc3.pc)) {
				done = true;
				this.batchMode = false;
				return this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.threadID));
			}
			if (this.lc3.subroutineLevel <= this.target) {
				// we've returned from the target subroutine
				done = true;
				this.batchMode = false;
				return this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
			}
			if (!this.lc3.isRunning()) {// we've halted
				done = true;
				this.batchMode = false;
				return this.sendEvent(new StoppedEvent('halt', MockDebugSession.threadID));
			}
			var op = this.lc3.nextInstruction();
			this.pcTrace.push(this.lc3.pc);
		}
	}


	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
	}

	/*
	* Run the program forever
	* aka "Run" in LC3 Web
	*/
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		console.log("continueRequest");
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
			this.sendEvent(new StoppedEvent('halted', MockDebugSession.threadID));
			return;
		}
		this.lc3.nextInstruction();
		this.pcTrace.push(this.lc3.pc);
		this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
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

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		/*
		const targets = this._runtime.getStepInTargets(args.frameId);
		response.body = {
			targets: targets.map(t => {
				return { id: t.id, label: t.label };
			})
		};
		*/
		this.sendResponse(response);
	}

	/*
	* Called when the user clicks "pause".
	* Returns the stack trace at the current pc, used to tell the editor the current line.
	* Currently the stack trace is just the current line. May implement actual stack frames in the future.
	*/
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const arrayStackFrames = new Array<StackFrame>();
		const line = this.getLineFromAddress(this.lc3.pc);
		const stackFrame: DebugProtocol.StackFrame = new StackFrame(0, `line ${line}`, this.createSource(), line);
		stackFrame.instructionPointerReference = this.format16BitHex(this.lc3.pc);
		arrayStackFrames.push(stackFrame);
		response.body = {
			stackFrames: arrayStackFrames,
			totalFrames: arrayStackFrames.length
		};
		this.sendResponse(response);
	}

	/* 
	* Called immediately after attachRequest. Used Promise to wait for the assembly to finish.
	* 
	*/
	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		console.log('setBreakPointsRequest');
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
	*/
	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		console.log("breakpointLocationsRequest");
		if (args.source.path) {
			response.body = {
				// assembly line number starts at 0, client line number starts at 1
				breakpoints: this.assemblyResult!.lineNumbers.map(line => {
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
		console.log("variablesRequest");
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
			console.log(startingAddress, this.lc3.memory[startingAddress]);
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
	*/
	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		/*
		let reply: string | undefined;
		let rv: Register | undefined;

		// To be determined 

		switch (args.context) {
			case 'repl':

			case 'hover':

			case 'watch':

			default:

				break;
		}

		if (rv) {
			const v = this.convertFromRuntime(rv);
			response.body = {
				result: v.value,
				type: v.type,
				variablesReference: v.variablesReference,
				presentationHint: v.presentationHint
			};
		} else {
			response.body = {
				result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
				variablesReference: 0
			};
		}

		this.sendResponse(response);
		*/
	}

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {
		/*
		if (args.expression.startsWith('$')) {
			const rv = this._runtime.getLocalVariable(args.expression.substr(1));
			if (rv) {
				rv.value = this.convertToRuntime(args.value);
				response.body = this.convertFromRuntime(rv);
				this.sendResponse(response);
			} else {
				this.sendErrorResponse(response, {
					id: 1002,
					format: `variable '{lexpr}' not found`,
					variables: { lexpr: args.expression },
					showUser: true
				});
			}
		} else {
			this.sendErrorResponse(response, {
				id: 1003,
				format: `'{lexpr}' not an assignable expression`,
				variables: { lexpr: args.expression },
				showUser: true
			});
		}
		*/
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		// data breakpoints are not supported
		response.body = {
			dataId: null,
			description: "cannot break on data access",
			accessTypes: undefined,
			canPersist: false
		};
		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {
		response.body = {
			breakpoints: []
		};
		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {
		// completions are not supported
		response.body = {
			targets: []
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancellationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			this._cancelledProgressId = args.progressId;
		}
	}

	protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {
		console.log("disassembleRequest");
		// Formatting is in principal always hex, preserved redundant code for future use.
		// memoryReference should be decimal, but it's fine since parseInt will figure it out.
		const memoryInt = args.memoryReference;
		const offset = args.instructionOffset || 0;
		const startAddress = parseInt(memoryInt) + offset;
		const count = args.instructionCount;
		const isHex = memoryInt.startsWith('0x');
		const pad = isHex ? memoryInt.length - 2 : memoryInt.length;
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
			const entry = Object.entries(this.assemblyResult!.symbolTable).find(([key, value]) => value === address);
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
		/*
		let lastLine = -1;
		const instructions = this._runtime.disassemble(baseAddress + offset, count).map(instruction => {
			let address = Math.abs(instruction.address).toString(isHex ? 16 : 10).padStart(pad, '0');
			const sign = instruction.address < 0 ? '-' : '';
			const instr: DebugProtocol.DisassembledInstruction = {
				address: sign + (isHex ? `0x${address}` : `${address}`),
				instruction: instruction.instruction
			};
			// if instruction's source starts on a new line add the source to instruction
			if (instruction.line !== undefined && lastLine !== instruction.line) {
				lastLine = instruction.line;
				instr.location = loc;
				instr.line = this.convertDebuggerLineToClient(instruction.line);
			}
			return instr;
		});

		response.body = {
			instructions: instructions
		};
		*/

	}

	protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments) {
		/*
		// clear all instruction breakpoints
		this._runtime.clearInstructionBreakpoints();

		// set instruction breakpoints
		const breakpoints = args.breakpoints.map(ibp => {
			const address = parseInt(ibp.instructionReference.slice(3));
			const offset = ibp.offset || 0;
			return <DebugProtocol.Breakpoint>{
				verified: this._runtime.setInstructionBreakpoint(address + offset)
			};
		});

		response.body = {
			breakpoints: breakpoints
		};
		*/
		this.sendResponse(response);
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		if (command === 'toggleFormatting') {
			this._valuesInHex = !this._valuesInHex;
			if (this._useInvalidatedEvent) {
				this.sendEvent(new InvalidatedEvent(['variables']));
			}
			this.sendResponse(response);
		} else {
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
				const memoryReference:number = this.assemblyResult!.symbolTable[name];
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

	private getAddressFromLine(clientLine: number): number {
		// Parameter line starts at 1, assemblyResult lineNumbers starts at 0
		var machineCodeRef = this.assemblyResult!.lineNumbers.findIndex((machineCodeLine, i) => machineCodeLine === clientLine - 1) || 0;
		if (machineCodeRef === -1) {
			return -1;
		}
		return machineCodeRef + this.assemblyResult!.orig || 0;
	}

	private getLineFromAddress(address: number): number {
		var addressIndex = address - this.assemblyResult!.orig;
		var searchIndex = this.pcTrace.length - 1;
		while (addressIndex > this.assemblyResult!.lineNumbers.length || addressIndex < 0) {
			// If in os territory, we need to go back the pcTrace to find the line number.
			if (searchIndex < 0) {
				return -1;
			}
			addressIndex = this.pcTrace[searchIndex--]! - this.assemblyResult!.orig;
		}
		return this.assemblyResult!.lineNumbers[addressIndex] + 1;
	}

}

