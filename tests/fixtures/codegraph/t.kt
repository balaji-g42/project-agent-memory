class Svc {
    fun run() {}
}

class Box {
    fun run() {}
}

class Other {
    fun run() {}
}

class T(private val svc: Svc) {
    fun go(o: Other) {
        svc.run()
        o.run()
        val x = Box()
        x.run()
    }
}
