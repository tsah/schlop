local M = {}
local rpc = require("schlop.rpc")
local uv = vim.uv or vim.loop
local function write_launch(value)
  local path = vim.fn.tempname() .. ".json"
  local fd = assert(uv.fs_open(path, "wx", 384))
  assert(uv.fs_write(fd, vim.json.encode(value) .. "\n", 0))
  assert(uv.fs_close(fd))
  return path
end
function M.start(launch, options)
  local path = type(launch) == "string" and launch or write_launch(launch)
  rpc.start(path, function(err, session)
    if type(launch) ~= "string" then pcall(uv.fs_unlink, path) end
    if err then
      vim.notify("Schlop: " .. err.message, vim.log.levels.ERROR)
      if options and options.standalone then vim.cmd("cquit 1") end
      return
    end
    require("schlop.ui").open(session, options or {})
  end)
end
return M
