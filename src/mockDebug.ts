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
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, MemoryEvent
} from '@vscode/debugadapter';

import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { Subject } from 'await-notify';
import { LC3 } from './lc3_core';
import { assemble } from './lc3_as.js';
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



export class MockDebugSession extends LoggingDebugSession {
	// 
	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// a Mock runtime (or debugger)

	// 
	private _variableHandles = new Handles<'registers' | Register>();

	private _configurationDone = new Subject();

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

	private breakpointID = 0;

	private fileAssessor: FileAccessor;

	protected attachPromise!: Promise<void>;
	protected breakpointsPromise!: Promise<void>;

	/*
	 * Array of the addresses with breakpoints assigned.
	 */
	private breakpointAddresses: number[] = [];
	private breakpointLines = [];


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
	 * The 'initialize' request is the first request called by the frontend
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
		response.body.supportsDisassembleRequest = false;
		response.body.supportsSteppingGranularity = false;
		response.body.supportsInstructionBreakpoints = true;

		// make VS Code able to read and write variable memory
		response.body.supportsReadMemoryRequest = false;
		response.body.supportsWriteMemoryRequest = false;

		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsDelayedStackTraceLoading = false;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
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
		this.attachPromise = new Promise(async (resolve, reject) => {
			this.programPath = args.program;
			let userCodeBytes = await this.fileAssessor.readFile(args.program);
			let userCode = new TextDecoder().decode(userCodeBytes);
			this.assemblyResult = assemble(userCode);
			if (this.assemblyResult === undefined) { resolve(); return; }
			if (this.assemblyResult.error) {
				var errorList = this.assemblyResult.error;
				this.sendErrorResponse(response, {
					id: 1001,
					format: `Assembly failed: ${errorList.join('\n')}`,
					showUser: true
				});
				resolve();
				return;
			}
			this.lc3.loadAssembled(this.assemblyResult);
			resolve();
		});
		await this.attachPromise;
		await this.breakpointsPromise;
		return this.launchRequest(response, args);
	}

	/*
	* Called by VS Code when the user clicks on 'Start Debugging'.
	*/
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(Logger.LogLevel.Verbose, false);
		// wait until configuration has finished (and configurationDoneRequest has been called)
		// removed a one-second wait
		await this._configurationDone;
		this.sendResponse(response);
		this.target = -Infinity;
		await this.enterBatchMode();
		return response;
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
			console.log(this.lc3.pc);
			// Go to the next instruction if we're recovering from a breakpoint.
			if(isRecoveredFromBreakpoint){
				var op = this.lc3.nextInstruction();
				this.pcTrace.push(this.lc3.pc);
			}
			// Check if we've hit a breakpoint
			if (this.breakpointAddresses.includes(this.lc3.pc)) {
				console.log('pause because breakpoint hit');
				done = true;
				this.batchMode = false;
				return this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.threadID));
			}
			if (this.lc3.subroutineLevel <= this.target) {
				// we've returned from the target subroutine
				done = true;
				this.batchMode = false;
				console.log('paused because subroutine return');	
				return this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
			}
			if (!this.lc3.isRunning()) {// we've halted
				done = true;
				this.batchMode = false;
				console.log('paused because halted');
				return this.sendEvent(new StoppedEvent('halt', MockDebugSession.threadID));
			}
			var op = this.lc3.nextInstruction();
			this.pcTrace.push(this.lc3.pc);
		}
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
	}

	/*
	* Run the program forever
	* aka "Run" in LC3 Web
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
			this.sendEvent(new StoppedEvent('halted', MockDebugSession.threadID));
			return;
		}
		this.lc3.nextInstruction();
		this.pcTrace.push(this.lc3.pc);
		this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
		console.log('stepInRequest ' + this.lc3.pc);
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
	* Returns the stack frame at the current pc, used to tell the editor the current line.
	* Currently the stack frame is just the current line. May implement actual stack frames in the future.
	*/
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const frames = new Array<StackFrame>();
		const line = this.getLineFromAddress(this.lc3.pc);
		frames.push(new StackFrame(0, `line ${line}`, this.createSource(), line, 0));
		response.body = {
		    stackFrames: frames,
		    totalFrames: frames.length
		};
		this.sendResponse(response);
	  }

	  /* 
	  * Called immediately after attachRequest. Used Promise to wait for the assembly to finish.
	  * 
	  */
	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		console.log('setBreakPointsRequest');
		if (this.attachPromise) {
			await this.attachPromise;
		}
		this.breakpointsPromise = new Promise(async (resolve, reject) => {
			const path = args.source.path as string;
			if (path !== this.programPath) {
				this.sendResponse(response);
				return;
			}
			const clientLines = args.lines || [];

			// save the lines for lc3
			//this.breakpointLines = clientLines.map(l => this.convertClientLineToDebugger(l));

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
			resolve();
		});

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
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		const variableType = this._variableHandles.get(args.variablesReference);
		if (variableType === 'registers') {
			response.body = {
				variables: this.lc3.r.map((r, i) => {
					return {
						name: "R" + i,
						value: this.formatNumber(r),
						// Not a parent variable
						variablesReference: 0
					};
				})
			};
		}
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		/*
		const container = this._variableHandles.get(args.variablesReference);
		let rv;
		if (container === 'locals') {
			rv = this._runtime.getLocalVariable(args.name);
		} else if (container instanceof RuntimeVariable && container.value instanceof Array) {
			rv = container.value.find(v => v.name === args.name);
		} else {
			rv = undefined;
		}

		if (rv) {
			rv.value = this.convertToRuntime(args.value);
			response.body = this.convertFromRuntime(rv);

			if (rv.memory && rv.reference) {
				this.sendEvent(new MemoryEvent(String(rv.reference), 0, rv.memory.length));
			}
		}
		*/
		this.sendResponse(response);
	}

	/*
	* Writes the value of a variable.
	*/
	protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments) {
		/*
		const variable = this._variableHandles.get(Number(memoryReference));
		if (typeof variable === 'object') {
			const decoded = Number(data);
			variable.value = decoded;
			response.body = { bytesWritten: 2 };
		} else {
			response.body = { bytesWritten: 0 };
		}
		*/
		// runtime does not support writing memory, so just return a zero bytesWritten.
		response.body = { bytesWritten: 0 };
		this.sendResponse(response);
		this.sendEvent(new InvalidatedEvent(['variables']));
	}

	protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments) {
		response.body = {
			address: offset.toString(),
			data: '',
			unreadableBytes: count
		};
		this.sendResponse(response);
	}

	

	private formatNumber(x: number): string{
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
		/*
		const memoryInt = args.memoryReference.slice(3);
		const baseAddress = parseInt(memoryInt);
		const offset = args.instructionOffset || 0;
		const count = args.instructionCount;

		const isHex = memoryInt.startsWith('0x');
		const pad = isHex ? memoryInt.length - 2 : memoryInt.length;

		const loc = this.createSource(this._runtime.sourceFile);

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
		this.sendResponse(response);
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
	private convertToRuntime(value: string): IRuntimeVariableType {

		value = value.trim();

		if (value === 'true') {
			return true;
		}
		if (value === 'false') {
			return false;
		}
		if (value[0] === '\'' || value[0] === '"') {
			return value.substr(1, value.length - 2);
		}
		const n = parseFloat(value);
		if (!isNaN(n)) {
			return n;
		}
		return value;
	}
	*/
	/*
		private convertFromRuntime(v: RuntimeVariable): DebugProtocol.Variable {
			
			let dapVariable: DebugProtocol.Variable = {
				name: v.name,
				value: '???',
				type: typeof v.value,
				variablesReference: 0,
				evaluateName: '$' + v.name
			};
	
			if (v.name.indexOf('lazy') >= 0) {
				// a "lazy" variable needs an additional click to retrieve its value
	
				dapVariable.value = 'lazy var';		// placeholder value
				v.reference ??= this._variableHandles.create(new RuntimeVariable('', [new RuntimeVariable('', v.value)]));
				dapVariable.variablesReference = v.reference;
				dapVariable.presentationHint = { lazy: true };
			} else {
	
				if (Array.isArray(v.value)) {
					dapVariable.value = 'Object';
					v.reference ??= this._variableHandles.create(v);
					dapVariable.variablesReference = v.reference;
				} else {
	
					switch (typeof v.value) {
						case 'number':
							if (Math.round(v.value) === v.value) {
								dapVariable.value = this.formatNumber(v.value);
								(<any>dapVariable).__vscodeVariableMenuContext = 'simple';	// enable context menu contribution
								dapVariable.type = 'integer';
							} else {
								dapVariable.value = v.value.toString();
								dapVariable.type = 'float';
							}
							break;
						case 'string':
							dapVariable.value = `"${v.value}"`;
							break;
						case 'boolean':
							dapVariable.value = v.value ? 'true' : 'false';
							break;
						default:
							dapVariable.value = typeof v.value;
							break;
					}
				}
			}
	
			if (v.memory) {
				v.reference ??= this._variableHandles.create(v);
				dapVariable.memoryReference = String(v.reference);
			}
	
			return dapVariable;
		}
			*/

	private formatAddress(x: number, pad = 8) {
		return 'mem' + (this._addressesInHex ? '0x' + x.toString(16).padStart(8, '0') : x.toString(10));
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
		while (addressIndex > this.assemblyResult!.lineNumbers.length || addressIndex < 0) {
			// If in os territory, we need to go back the pcTrace to find the line number.
			if (this.pcTrace.length === 0) {
				return -1;
			}
			addressIndex = this.pcTrace.pop()! - this.assemblyResult!.orig;
		}
		return this.assemblyResult!.lineNumbers[addressIndex] + 1;
	}

}

