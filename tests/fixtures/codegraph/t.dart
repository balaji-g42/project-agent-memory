class Svc { void run() {} }
class Box { void run() {} }
class Other { void run() {} }
class T {
  final Svc svc;
  void go(Other o) { svc.run(); o.run(); var x = Box(); x.run(); }
}
