local M = {}
function M.a() M.b() end
function M.b() end
local function top() helper() end
function helper() end
