.ORIG x3000
GETC
LD R1, MINUS_0
ADD R1, R1, R0
JSR MULTIPLY      ; R2 = R0 * R1
ADD R2, R2, #5    ; R2 = R2 + 5
HALT

MINUS_0 .FILL #-48

; Function: MULTIPLY
; Description: Multiplies two numbers, save R0 * 1 ... R0 * R1 to ARRAY 
;     and -R0 * 1 ... -R0 * R1 to HEAP
; Input: R0, R1
; Output: R2 = R0 * R1
; Registers used:
;     R0 - multiplier
;     R1 - multiplicand
;     R2 - product
;     R3 - array head
;     R4 - temp
;     R5 - heap head
;     R6 - counter
; All registers are callee-saved
;@SUBROUTINE
MULTIPLY    ;function MULTIPLY(R0, R1) returns R2
ST R0, M_R0
ST R7, M_R7

ADD R6, R6, R1
M_LOOP
ADD R6, R6, #-1
BRn M_DONE
LD R0,START_CHAR
ADD R0, R0, R6
OUT
BRnzp M_LOOP
M_DONE

LD R0, M_R0
LD R7, M_R7
RET
START_CHAR .FILL #97
;@VARIABLE
M_R0 .BLKW #1
;@VARIABLE
M_R7 .BLKW #1  
;@VARIABLE
ARRAY .BLKW #10
;;@VARIABLE:HEAP:x8000:10
HEAP_ADD .FILL x8000

.END

.ORIG x8000
;@VARIABLE
HEAP .BLKW #10
.END