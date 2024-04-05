.ORIG x3000
AND R0, R0, #0
ADD R0, R0, #3    ; R0 = 3
AND R1, R1, #0
ADD R1, R1, #4    ; R1 = 4
JSR MULTIPLY      ; R2 = R0 * R1
ADD R2, R2, #5    ; R2 = R2 + 5
HALT

; Input: R0, R1
; Output: R2 = R0 * R1
; Registers used:
;     R0 - multiplier
;     R1 - multiplicand
;     R2 - product
;     R6 - counter
; All registers are callee-saved
;@SUBROUTINE
MULTIPLY    ;function MULTIPLY(R0, R1) returns R2
ST R6, M_R6
ST R7, M_R7

ADD R6, R6, R1
M_LOOP
ADD R6, R6, #-1
BRn M_DONE
ADD R2, R2, R0
BRnzp M_LOOP
M_DONE

LD R6, M_R6
LD R7, M_R7
RET
M_R6 .BLKW #1
M_R7 .BLKW #1
.END