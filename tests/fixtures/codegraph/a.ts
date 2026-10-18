import { helper } from './b.js';
export class A {
  run(): void { helper(); this.stop(); }
  stop() {}
}
interface I { x: number }
enum E { Q }
const arrow = () => new A();
