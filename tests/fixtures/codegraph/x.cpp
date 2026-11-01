#include "h.h"
namespace ns { class C { public: void m(); void n() {} }; }
void ns::C::m() { this->n(); free_fn(); }
void free_fn() {}
struct T { void go() { free_fn(); } };
