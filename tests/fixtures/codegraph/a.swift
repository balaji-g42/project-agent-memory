import Foundation
import struct M.S
protocol P { func z() }
enum E { case a }
struct S { func s() {} }
class A: P {
    init() {}
    func z() {
        foo()
        b.baz(1)
    }
}
extension A { func q() {} }
func foo() {}
