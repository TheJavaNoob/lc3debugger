//code.stephenmorley.org
export class Queue {
      public a:any[] = [];
      public b = 0;
      getLength() { return this.a.length - this.b; };
      isEmpty() { return 0 == this.a.length; };
      enqueue (b) { this.a.push(b); };
      dequeue () { if (0 != this.a.length) { var c = this.a[this.b]; 2 * ++this.b >= this.a.length && (this.a = this.a.slice(this.b), this.b = 0); return c; } };
      peek () { return 0 < this.a.length ? this.a[this.b] : void 0; };
      
};
