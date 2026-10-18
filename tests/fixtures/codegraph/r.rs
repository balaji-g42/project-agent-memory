struct R;
impl R { fn m(&self) { free(); self.n(); } fn n(&self) {} }
fn free() {}
