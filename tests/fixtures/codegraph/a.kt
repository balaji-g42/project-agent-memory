package a.b
import x.y.Z
import x.y.*
interface I { fun z() }
enum class E { A }
object O { fun o() {} }
class A : I {
    override fun z() {
        foo()
        bar.baz(1)
    }
}
fun A.ext() {}
fun foo() {}
