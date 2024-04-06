.ORIG x3000
AND R0, R0, #0
ADD R0, R0, #3    ; R0 = 3
AND R1, R1, #0
ADD R1, R1, #4    ; R1 = 4
JSR MULTIPLY      ; R2 = R0 * R1
ADD R2, R2, #5    ; R2 = R2 + 5
HALT

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
ST R6, M_R6
ST R7, M_R7
LEA R3, ARRAY
LD R5, HEAP

AND R2, R2, #0
ADD R6, R6, R1
M_LOOP
ADD R6, R6, #-1
BRn M_DONE
ADD R2, R2, R0    ; R2 = R2 + R0

ADD R4, R2, #0
NOT R4, R4
ADD R4, R4, #1    ; R4 = -R2

STR R2, R3, #0    ; save R2 to ARRAY
ADD R3, R3, #1 

STR R4, R5, #0    ; save R4 to HEAP
ADD R5, R5, #1
BRnzp M_LOOP
M_DONE

LD R6, M_R6
LD R7, M_R7
RET
;@VARIABLE
M_R6 .BLKW #1
;@VARIABLE
M_R7 .BLKW #1  
;@VARIABLE
ARRAY .BLKW #10
;@VARIABLE:HEAP:x8000:10
HEAP .FILL x8000

.END