class Svc { func run() {} }
class Box { func run() {} }
class Other { func run() {} }
class T {
    let svc: Svc
    func go(o: Other) {
        svc.run()
        o.run()
        let x = Box()
        x.run()
    }
}
