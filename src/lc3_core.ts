import { Queue } from './Queue';
import { LC3Util } from './lc3_util';
import { lc3os, lc3osSymbols } from './lc3_os';
export class LC3 {
    public memory: number[];
    public listeners: any[];
    // Registers, starts at R0 and goes to R7.
    public r: number[];
    public specialRegisters: string[];
    public labelToAddress;
    public addressToLabel;
    public maxStandardMemory: number;
    public kbiv: number;
    public div: number;
    public kbsr = 0xFE00;
    public kbdr = 0xFE02;
    public dsr = 0xFE04;
    public ddr = 0xFE06;
    public mcr = 0xFFFE;
    public pc = 0x3000;
    public ir = 0;
    public psr = 0x8002;
    public ioLocations = [this.kbsr, this.kbdr, this.dsr, this.ddr];
    public kbpl = 2;
    public dpl = 1;
    public namedTrapVectors = {
        0x20: 'GETC',
        0x21: 'OUT',
        0x22: 'PUTS',
        0x23: 'IN',
        0x24: 'PUTSP',
        0x25: 'HALT',
    };

    // A queue of keys that the user has entered, but have not been processed.
    public bufferedKeys = new Queue();

    // The current subroutine depth. Used for next/continue.
    public subroutineLevel = 0;
    constructor() {
        // Create and initialize memory; load from OS if possible
        this.memory = new Array(0x10000);
        for (var i = 0; i < this.memory.length; i++) {
            var osEntry = lc3os[i];
            this.memory[i] = (osEntry === undefined) ? 0 : osEntry;
        }

        // Listeners for when registers, memory, etc. are changed
        this.listeners = [];
        

        // Create and initialize registers
        this.r = new Array(8);
        this.specialRegisters = ['pc', 'ir', 'psr'];
        this.resetAllRegisters();

        // Dictionaries for linking addresses and labels
        this.labelToAddress = {};
        this.addressToLabel = {};

        // Load OS symbols
        for (var label in lc3osSymbols) {
            var address = lc3osSymbols[label];
            this.setLabel(address, label);
        }

        // Exclusive upper bound for normal memory
        // Memory address 0xFE00 and up are mapped to devices
        this.maxStandardMemory = 0xFE00;

        // Addresses of mapped memory locations
        this.kbsr = 0xFE00;
        this.kbdr = 0xFE02;
        this.dsr = 0xFE04;
        this.ddr = 0xFE06;
        this.mcr = 0xFFFE;
        this.ioLocations = [this.kbsr, this.kbdr, this.dsr, this.ddr];

        // Device interrupt vectors
        this.kbiv = 0x0180;
        this.div = 0x0181; // TODO is this right? not specified


        // Device priority levels
        this.kbpl = 2;
        this.dpl = 1;

        this.namedTrapVectors = {
            0x20: 'GETC',
            0x21: 'OUT',
            0x22: 'PUTS',
            0x23: 'IN',
            0x24: 'PUTSP',
            0x25: 'HALT',
        };

        // A queue of keys that the user has entered, but have not been processed.
        this.bufferedKeys = new Queue();

        // The current subroutine depth. Used for next/continue.
        this.subroutineLevel = 0;
    }
    addListener (callback) {
        this.listeners.push(callback);
    };
    notifyListeners (e) {
        for (var i = 0; i < this.listeners.length; i++) {
            this.listeners[i](e);
        }
    };
    formatAddress(address) {
        var label = this.addressToLabel[address];
        return (label !== undefined) ? label : LC3Util.toHexString(address);
    }
    getConditionCode() {
        var n = (this.psr & 4) >> 2;
        var z = (this.psr & 2) >> 1;
        var p = (this.psr & 1);
        if ((n ^ z ^ p) && !(n && z && p)) {
            return n ? -1 : z ? 0 : 1;
        } else {
            return undefined;
        }
    }
    setConditionCode(value) {
        value = LC3Util.toInt16(value);
        var n = value < 0;
        var p = value > 0;
        var z = !n && !p;

        var mask = (n ? 0x4 : 0) | (z ? 0x2 : 0) | (p ? 0x1 : 0);
        this.setRegister('psr', this.psr & 0xFFF8 | mask);
    }
    // Stages of the instruction cycle
    nextInstruction() {
        // Store any keypresses since last time.
        this.updateIO();

        // Perform the instruction cycle.
        this.fetch();
        var op = this.decode(this.ir);
        var address = this.evaluateAddress(this.pc, op);
        var operand = this.fetchOperands(address);
        var result = this.execute(op, address, operand);
        this.storeResult(op, result);

        // Display any output since last time.
        this.updateIO();

        // Check for I/O interrupts.
        this.checkInterrupts();

        return op;
    }
    fetch() {
        this.ir = this.getMemory(this.pc);
        this.setRegister('pc', this.pc + 1);
    }
    decode(instruction) {
        // We'll augment this object depending on the opcode.
        var op:any = {}
        op.raw = instruction;
        op.strictValid = true;

        var bits = Array(16);
        for (var i = 0; i < bits.length; i++) {
            bits[i] = (instruction >> i) & 0x1;
        }

        op.opcode = (instruction >> 12) & 0xF;

        var bits05 = instruction & 0x3F;
        var bits68 = (instruction >> 6) & 0x7;
        var bits08 = instruction & 0x1FF;
        var bits911 = (instruction >> 9) & 0x7;
        var bits010 = instruction & 0x7FF;

        var valid = true;
        switch (op.opcode) {
            case 1: // ADD
            case 5: // AND
                op.opname = (op.opcode === 1 ? 'ADD' : 'AND');
                op.dr = bits911;
                op.sr1 = bits68;
                op.mode = 'none';
                if (bits[5] === 0) {
                    op.arithmeticMode = 'reg';
                    op.sr2 = instruction & 0x7;
                    if (bits[4] !== 0 || bits[3] !== 0) {
                        op.strictValid = false;
                    }
                } else {
                    op.arithmeticMode = 'imm';
                    op.imm = LC3Util.signExtend16(instruction & 0x1F, 5);
                }
                break;
            case 0: // BR
                op.opname = 'BR';
                op.n = (bits[11] == 1);
                op.z = (bits[10] == 1);
                op.p = (bits[9] == 1);
                op.mode = 'pcOffset';
                op.offset = LC3Util.signExtend16(bits08, 9);
                break;
            case 12: // JMP, RET
                op.opname = (bits68 === 7 ? 'RET' : 'JMP');
                op.mode = 'baseOffset';
                op.baseR = bits68;
                op.offset = 0;
                if (bits911 !== 0 || bits05 !== 0) {
                    op.strictValid = false;
                }
                break;
            case 4: // JSR, JSRR
                if (bits[11] === 0) {
                    op.opname = 'JSRR';
                    op.mode = 'baseOffset';
                    op.baseR = bits68;
                    op.offset = 0;
                    if (bits911 !== 0 || bits05 !== 0) {
                        op.strictValid = false;
                    }
                } else {
                    op.opname = 'JSR';
                    op.mode = 'pcOffset';
                    op.offset = LC3Util.signExtend16(bits010, 11);
                }
                break;
            case 2: // LD
            case 10: // LDI
                op.opname = (op.opcode === 2 ? 'LD' : 'LDI');
                op.dr = bits911;
                op.mode = 'pcOffset';
                op.offset = LC3Util.signExtend16(bits08, 9);
                break;
            case 6: // LDR
                op.opname = 'LDR';
                op.dr = bits911;
                op.mode = 'baseOffset';
                op.baseR = bits68;
                op.offset = LC3Util.signExtend16(bits05, 6);
                break;
            case 14: // LEA
                op.opname = 'LEA';
                op.dr = bits911;
                op.mode = 'pcOffset';
                op.offset = LC3Util.signExtend16(bits08, 9);
                break;
            case 9: // NOT
                op.opname = 'NOT';
                op.mode = 'none';
                op.dr = bits911;
                op.sr = bits68;
                if (bits05 !== 0x3F) {
                    op.strictValid = false;
                }
                break;
            case 8: // RTI
                op.opname = 'RTI';
                op.mode = 'none';
                if ((instruction & 0xFFF) !== 0) {
                    op.strictValid = false;
                }
                break;
            case 3: // ST
            case 11: // STI
                op.opname = (op.opcode === 3 ? 'ST' : 'STI');
                op.sr = bits911;
                op.mode = 'pcOffset';
                op.offset = LC3Util.signExtend16(bits08, 9);
                break;
            case 7: // STR
                op.opname = 'STR';
                op.sr = bits911;
                op.mode = 'baseOffset';
                op.baseR = bits68;
                op.offset = LC3Util.signExtend16(bits05, 6);
                break;
            case 15: // TRAP
                op.opname = 'TRAP';
                op.mode = 'trap';
                op.trapVector = instruction & 0xFF;
                if (0 !== (instruction & 0x0F00)) {
                    op.strictValid = false;
                }
                break;
            default:
                op.opname = 'reserved';
                op.strictValid = false;
                break;
        }
        return op;
    }
    evaluateAddress(pc, op) {
        if (op.mode === 'none') {
            return null;
        } else if (op.mode === 'pcOffset') {
            return LC3Util.toUint16(pc + op.offset);
        } else if (op.mode === 'baseOffset') {
            return LC3Util.toUint16(this.getRegister(op.baseR) + op.offset);
        } else if (op.mode === 'trap') {
            return op.trapVector;
        } else {
            return undefined;
        }
    }
    fetchOperands(address) {
        if (address === null || address === undefined) {
            return address;
        }
        return this.readMemory(address);
    }
    execute(op, address, operand) {
        op.isIO = false;
        switch (op.opcode) {
            case 1: // ADD
            case 5: // AND
                var x1 = this.getRegister(op.sr1);
                var x2 = op.arithmeticMode === 'reg'
                    ? this.getRegister(op.sr2)
                    : op.imm;
                return (op.opcode === 1 ? x1 + x2 : x1 & x2);
            case 0: // BR
                var cc = this.getConditionCode();
                var doBreak = cc === undefined
                    || (op.n && cc < 0)
                    || (op.z && cc === 0)
                    || (op.p && cc > 0);
                if (doBreak) {
                    this.setRegister('pc', address);
                }
                return null;
            case 12: // JMP, RET
                this.setRegister('pc', address);
                // internal: decrement depth on return
                if (op.opname === 'RET') {
                    this.subroutineLevel--;
                }
                return null;
            case 4: // JSR, JSRR
                this.setRegister(7, this.pc);
                this.setRegister('pc', address);
                // internal: also increment the depth
                this.subroutineLevel++;
                return null;
            case 2: // LD
                if (this.ioLocations.indexOf(address) !== -1) {
                    op.isIO = true;
                }
                return operand;
            case 10: // LDI
                if (this.ioLocations.indexOf(operand) !== -1) {
                    op.isIO = true;
                }
                return this.readMemory(operand);
            case 6: // LDR
                if (this.ioLocations.indexOf(address) !== -1) {
                    op.isIO = true;
                }
                return operand;
            case 14: // LEA
                return address;
            case 9: // NOT
                return LC3Util.toUint16(~this.getRegister(op.sr));
            case 8: // RTI
                if ((this.psr & 0x8000) !== 0) {
                    // Privilege mode exception
                    var ev = {
                        type: 'exception',
                        exception: 'privilege'
                    };
                    this.notifyListeners(ev);
                    this.halt();
                } else {
                    var r6 = this.r[6];
                    this.setRegister('pc', this.readMemory(r6));
                    this.setRegister('psr', this.readMemory(r6 + 1));
                    this.setRegister(6, r6 + 2);
                }
                return null;
            case 3: // ST
                if (this.ioLocations.indexOf(address) !== -1) {
                    op.isIO = true;
                }
                this.writeMemory(address, this.getRegister(op.sr));
                return null;
            case 11: // STI
                if (this.ioLocations.indexOf(operand) !== -1) {
                    op.isIO = true;
                }
                this.writeMemory(operand, this.getRegister(op.sr));
                return null;
            case 7: // STR
                if (this.ioLocations.indexOf(address) !== -1) {
                    op.isIO = true;
                }
                this.writeMemory(address, this.getRegister(op.sr));
                return null;
            case 15: // TRAP
                this.setRegister(7, this.pc);
                this.setRegister('pc', operand);
                // internal: also increment the depth
                this.subroutineLevel++;
                return null;
            case 13:
                // Illegal opcode exception
                var ev = {
                    type: 'exception',
                    exception: 'opcode'
                };
                this.notifyListeners(ev);
                this.halt();
                return null;
            default:
                return undefined;
        }
    }
    storeResult(op, result) {
        switch (op.opcode) {
            case 1: // ADD
            case 5: // AND
            case 9: // NOT
                this.setRegister(op.dr, result);
                this.setConditionCode(result);
                break;
            case 0: // BR
            case 12: // JMP, RET
            case 4: // JSR, JSRR
                // Nothing to do here.
                return;
            case 2: // LD
            case 10: // LDI
            case 6: // LDR
            case 14: // LEA
                this.setRegister(op.dr, result);
                this.setConditionCode(result);
                break;
            case 8: // RTI
                // Nothing to do here.
                return;
            case 3: // ST
            case 11: // STI
            case 7: // STR
                // Still nothing to do here.
                return;
            case 15: // TRAP
                // Nothing to do here, either!
                break;
            default:
                break;
        }
    }
    instructionToString(inAddress, instruction) {
        var op = this.decode(instruction);
        if (!op.strictValid) {
            return '.FILL ' + LC3Util.toHexString(op.raw);
        }
        var reg = function (i) {
            return 'R' + i;
        };
        if (!op.strictValid) {
            return '.FILL ' + LC3Util.toHexString(op.raw);
        }
        var prefix = op.opname + ' ';
        var pc = inAddress + 1;
        var address = this.evaluateAddress(pc, op);
        switch (op.opcode) {
            case 1: // ADD
            case 5: // AND
                var x1 = reg(op.sr1);
                var x2 = op.arithmeticMode == 'reg' ? (reg(op.sr2)) : ('#' + op.imm);
                var dest = reg(op.dr);
                return prefix + [dest, x1, x2].join(', ');
            case 9: // NOT
                return prefix + [reg(op.dr), reg(op.sr)].join(', ');
            case 0: // BR
                // If all the NZP bits are zero,
                // or it just jumps to the next location,
                // then it's a NOP.
                if ((op.raw & 0x0E00) === 0 || (op.offset === 0)) {
                    return 'NOP';
                }
                var opname = 'BR';
                if (op.n) opname += 'n';
                if (op.z) opname += 'z';
                if (op.p) opname += 'p';
                return opname + ' ' + this.formatAddress(address);
            case 12: // JMP, RET
                var baseR = op.baseR;
                if (baseR === 7) {
                    return 'RET';
                } else {
                    return 'JMP ' + reg(baseR);
                }
            case 4: // JSR, JSRR
                if (op.mode === 'pcOffset') {
                    // JSR
                    return prefix + this.formatAddress(address);
                } else {
                    // JSRR
                    return prefix + reg(op.baseR);
                }
            case 2: // LD
            case 10: // LDI
            case 14: // LEA
                return prefix + [reg(op.dr), this.formatAddress(address)].join(', ');
            case 6: // LDR
                return prefix + [reg(op.dr), reg(op.baseR), '#' + op.offset].join(', ');
            case 8: // RTI
                return op.opname;
            case 3: // ST
            case 11: // STI
                return prefix + [reg(op.sr), this.formatAddress(address)].join(', ');
            case 7: // STR
                return prefix + [reg(op.sr), reg(op.baseR), '#' + op.offset].join(', ');
            case 15: // TRAP
                var namedTrap = this.namedTrapVectors[address];
                if (namedTrap !== undefined) {
                    return namedTrap;
                } else {
                    return prefix + LC3Util.toHexString(address, 2);
                }
            default:
                return null;
        }
    }
    instructionAddressToString(address) {
        return this.instructionToString(address, this.getMemory(address));
    }
    /*
     * Links a label with an address and notifies listeners.
     */
    setLabel(address, label) {
        // Unlink a previous label to the same address or of the same name.
        this.unsetLabelGivenAddress(address);
        this.unsetLabelGivenName(label);

        // Set up the new label and notify listeners.
        this.labelToAddress[label] = address;
        this.addressToLabel[address] = label;
        var ev = {
            type: 'labelset',
            address: address,
            label: label,
        };
        this.notifyListeners(ev);
    }
    /*
     * Deletes a label at the given address.
     * Returns true if the given label existed, else false.
     */
    unsetLabelGivenAddress(address) {
        var label = this.addressToLabel[address];
        var hasLabel = (label !== undefined);
        if (!hasLabel) {
            return false;
        }
        this.unsetLabel_internal_(address, label);
        return true;
    }
    /*
     * Deletes a label with the given name.
     * Returns true if the given label existed, else false.
     */
    unsetLabelGivenName(label) {
        var address = this.labelToAddress[label];
        var hasLabel = (address !== undefined);
        if (!hasLabel) {
            return false;
        }
        this.unsetLabel_internal_(address, label);
        return true;
    }
    /*
     * Internal command to unset a label at the given name and address.
     */
    unsetLabel_internal_(address, label) {
        delete this.addressToLabel[address];
        delete this.labelToAddress[label];
        var ev = {
            type: 'labelunset',
            address: address,
            label: label,
        };
        this.notifyListeners(ev);
    }
    // Functions to get and set memory.
    // getMemory and setMemory are the referentially transparent versions of
    // readMemory and writeMemory, respectively.
    getMemory(address) {
        return this.memory[address];
    }
    setMemory(address, data) {
        var ev = {
            type: 'memset',
            address: address,
            newValue: data
        };
        this.memory[address] = LC3Util.toUint16(data);
        this.notifyListeners(ev);
    }
    // Functions to read from and write to memory.
    // If these interact with data/status registers, other memory may be changed!
    // If you just want to purely inspect the data, use (get|set)Memory instead.
    readMemory(address) {
        if (address === this.kbdr) {
            // Reading KBDR: must turn off KBSR.
            this.setMemory(this.kbsr, this.getMemory(this.kbsr) & 0x7FFF);
        }
        return this.getMemory(address);
    }
    writeMemory(address, data) {
        if (address === this.ddr) {
            // Writing DDR: must turn of DSR.
            this.setMemory(this.dsr, this.getMemory(this.dsr) & 0x7FFF);
        }
        this.setMemory(address, data);
    }
    // Functions to get and set registers (standard or special)
    getRegister(register) {
        if (!isNaN(register) && register >= 0 && register < this.r.length) {
            return this.r[register];
        }
        for (var i = 0; i < this.specialRegisters.length; i++) {
            var name = this.specialRegisters[i];
            if (name === register) {
                return this[name];
            }
        }
        return undefined;
    }
    setRegister(register, value) {
        value = LC3Util.toUint16(value);
        var ev = {
            type: 'regset',
            register: '',
            newValue: value
        };
        if (!isNaN(register) && register >= 0 && register < this.r.length) {
            ev.register = register;
            this.r[register] = value;
            this.notifyListeners(ev);
            return true;
        }
        for (var i = 0; i < this.specialRegisters.length; i++) {
            var name = this.specialRegisters[i];
            if (name === register) {
                ev.register = name;
                this[name] = value;
                this.notifyListeners(ev);
                return true;
            }
        }
        return false;
    }
    resetNumericRegisters() {
        for (var i = 0; i < this.r.length; i++) {
            this.r[i] = 0;
        }
    }
    resetAllRegisters() {
        this.resetNumericRegisters();
        this.pc = 0x3000;
        this.ir = 0;
        this.psr = 0x8002;
    }
    formatConditionCode() {
        var code = this.getConditionCode();
        if (code === undefined) {
            return "Invalid";
        } else if (code > 0) {
            return "P";
        } else if (code < 0) {
            return "N";
        } else {
            return "Z";
        }
    }
    sendKey(character) {
        this.bufferedKeys.enqueue(character);
        this.notifyListeners({ type: 'bufferchange' });
    }
    updateIO() {
        // Check keyboard.
        var kbsrValue = this.getMemory(this.kbsr);
        var kbsrReady = (kbsrValue & 0x8000) === 0;
        if (kbsrReady && !this.bufferedKeys.isEmpty()) {
            this.setMemory(this.kbsr, kbsrValue | 0x8000);
            this.setMemory(this.kbdr, this.bufferedKeys.dequeue() & 0x00FF);
            this.notifyListeners({ type: 'bufferchange' });
        }

        // Check display output.
        var dsrValue = this.getMemory(this.dsr);
        var dsrReady = (dsrValue & 0x8000) === 0;
        if (dsrReady) {
            var key = this.getMemory(this.ddr) & 0x00FF;
            var ev = {
                type: 'keyout',
                value: key,
            };
            this.notifyListeners(ev);
            this.setMemory(this.dsr, dsrValue | 0x8000);
        }
    }
    clearBufferedKeys() {
        // This Queue library has no clear function.
        this.bufferedKeys = new Queue();
        this.notifyListeners({ type: 'bufferchange' });
    }
    /*
     * Determines whether the clock is running.
     */
    isRunning() {
        return (this.getMemory(this.mcr) & 0x8000) !== 0;
    }
    /*
     * Manually initiates the equivalent of a HALT command.
     */
    halt() {
        this.setMemory(this.mcr, this.getMemory(this.mcr) & 0x7FFF);
    }
    /*
     * Unhalts the clock after a HALT command.
     */
    unhalt() {
        this.setMemory(this.mcr, this.getMemory(this.mcr) | 0x8000);
    }
    /*
     * Load an assembly result into the LC-3.
     * Return true on success, false on failure.
     */
    loadAssembled(assemblyResult) {
        if (assemblyResult.error) {
            return false;
        }

        var orig = assemblyResult.orig;
        var mc = assemblyResult.machineCode;
        var symbols = assemblyResult.symbolTable || {};

        // Add all the instructions.
        for (var i = 0; i < mc.length; i++) {
            this.setMemory(orig + i, mc[i]);
        }

        // Add all the symbols.
        for (var labelName in symbols) {
            this.setLabel(symbols[labelName], labelName);
        }

        // Snap the PC to the origin point.
        this.setRegister('pc', orig);
    }
    checkInterrupts() {
        // Mask of only the ready and interrupt-enabled bits
        var interruptMask = 0xC000;
        // Check the keyboard
        if ((this.getMemory(this.kbsr) & interruptMask) === interruptMask) {
            this.interrupt(this.kbpl, this.getMemory(this.kbiv));
        }
        // Check the display
        if ((this.getMemory(this.dsr) & interruptMask) === interruptMask) {
            this.interrupt(this.dpl, this.getMemory(this.div));
        }
    }
    interrupt(priorityLevel, newPC) {
        // Check to see if the new priority level is higher than the current.
        // If not, don't interrupt.
        if (priorityLevel <= ((this.psr & 0x0700) >> 8)) {
            return;
        }

        // Get supervisor stack pointer
        var ssp = this.getRegister(6);

        // Stash PSR
        ssp--;
        this.setMemory(ssp, this.psr);

        // Stash PC
        ssp--;
        this.setMemory(ssp, this.pc);

        // Clear privilege, priority, and condition codes
        // (clear bits 15, 10:8, and 2:0),
        // then set the new priority level.
        this.psr &= 0x78F8;
        this.psr |= (priorityLevel & 0x7) << 8;

        // Set new PC
        this.setRegister('pc', newPC);

        // Set new supervisor stack pointer
        this.setRegister(6, ssp);
    }
}






















