import 'b.dart';
import "c.dart" as c;
enum E { a }
abstract class I { void z(); }
class A extends B with M {
  A();
  void m() { foo(); c.bar(1); this.n(); }
  int get g => 1;
}
extension X on A { void q() {} }
mixin M {}
void foo() { A().m(); bee(); }
