local rpc = require("schlop.rpc")
local config = require("schlop.config")
local M = {}
local ns = vim.api.nvim_create_namespace("schlop_annotations")
local state = { document = 1, side = "new", standalone = false, closed = false }

local function immutable(buf)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true
  vim.bo[buf].modeline = false
  vim.bo[buf].undofile = false
end
local function set_lines(buf, lines)
  vim.bo[buf].readonly = false
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true
end
local function map(buf, modes, lhs, rhs, description)
  if lhs and lhs ~= "" then vim.keymap.set(modes, lhs, rhs, { buffer = buf, silent = true, desc = "Schlop: " .. description }) end
end
-- Whether a rendered content row lies inside an annotation target.
local function row_matches(row, target)
  if not row.target or target.documentId ~= row.target.documentId then return false end
  if target.kind == "document" then return true end
  if target.kind == "text-range" then return row.line >= target.startLine and row.line <= target.endLine end
  return target.kind == "diff-range" and row.hunkId == target.hunkId and row.side == target.side and row.line >= target.startLine and row.line <= target.endLine
end
-- Column conversions use UTF-16 units so they match the controller's string indexes.
local function char_column(text, byte_col)
  local ok, value = pcall(vim.str_utfindex, text, "utf-16", byte_col - 1)
  if not ok then value = select(2, vim.str_utfindex(text, byte_col - 1)) end
  return value + 1
end
-- Whether a column-limited target covers the cursor column on its start or end line.
local function covers_column(target, line, column)
  if not target.startColumn or not target.endColumn then return true end
  if line == target.startLine and column < target.startColumn then return false end
  if line == target.endLine and column > target.endColumn then return false end
  return true
end
-- Annotations on the cursor row. Column-spanned ones that contain the cursor
-- win over whole-line ones, so several annotations on one line stay addressable.
local function annotations_at_cursor()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local row = state.rows and state.rows[cursor[1]]
  if not row or not row.target then return {} end
  local column = char_column(vim.api.nvim_get_current_line(), cursor[2] + 1)
  local matching, spanned = {}, {}
  for _, annotation in ipairs(state.session.annotations) do
    local target = annotation.target
    if row_matches(row, target) then
      table.insert(matching, annotation)
      if target.startColumn and covers_column(target, row.line, column) then table.insert(spanned, annotation) end
    end
  end
  return #spanned > 0 and spanned or matching
end
local function byte_offset(text, char_col)
  local ok, value = pcall(vim.str_byteindex, text, "utf-16", char_col - 1)
  if not ok then value = vim.str_byteindex(text, char_col - 1, true) end
  return value
end
-- Byte span of a text-range target on one rendered line, or nil for whole-line targets.
local function span_bytes(text, target, line_number)
  if target.kind ~= "text-range" or not target.startColumn or not target.endColumn then return nil end
  local first = line_number == target.startLine and byte_offset(text, target.startColumn) or 0
  local last = line_number == target.endLine and byte_offset(text, math.min(target.endColumn + 1, char_column(text, #text + 1))) or #text
  return first, last
end
local function build_rows()
  local document = state.session.surface.documents[state.document]
  local rows, lines = {}, {}
  if not document then return { "(no changed documents)" }, { {} } end
  if state.session.surface.kind == "text" or state.session.surface.kind == "markdown" then
    for _, line in ipairs(document.lines) do
      table.insert(lines, line.content)
      table.insert(rows, { target = { kind = "text-range", surfaceSnapshotId = state.session.surface.snapshotId, documentId = document.id, startLine = line.number, endLine = line.number }, line = line.number })
    end
  else
    for _, hunk in ipairs(document.hunks) do
      table.insert(lines, hunk.header)
      table.insert(rows, { header = true })
      for _, line in ipairs(hunk.lines) do
        local side = line.kind == "deletion" and "old" or (line.kind == "addition" and "new" or state.side)
        local number = side == "old" and line.oldLine or line.newLine
        local sign = line.kind == "deletion" and "-" or (line.kind == "addition" and "+" or " ")
        table.insert(lines, string.format("%4s %4s %s %s", line.oldLine or "", line.newLine or "", sign, line.content))
        table.insert(rows, { target = { kind = "diff-range", surfaceSnapshotId = state.session.surface.snapshotId, documentId = document.id, hunkId = hunk.id, side = side, startLine = number, endLine = number }, hunkId = hunk.id, side = side, line = number, line_kind = line.kind })
      end
    end
  end
  if #lines == 0 then lines = { "(empty document)" }; rows = { {} } end
  return lines, rows
end
local function render_sidebar()
  if not state.sidebar_buf or not vim.api.nvim_buf_is_valid(state.sidebar_buf) then return end
  local lines = { " SCHLOP", " " .. state.session.surface.title, "", " Documents" }
  state.sidebar_items = {}
  for index, document in ipairs(state.session.surface.documents) do
    local inspected = vim.tbl_contains(state.session.progress.inspectedDocumentIds, document.id) and "✓" or " "
    table.insert(lines, string.format(" %s %s%s", inspected, index == state.document and "› " or "  ", document.title))
  end
  table.insert(lines, "")
  table.insert(lines, " Annotations (" .. #state.session.annotations .. ")")
  for _, annotation in ipairs(state.session.annotations) do
    local line = #lines + 1
    local body = annotation.body:gsub("\n.*", "")
    table.insert(lines, " • " .. body)
    state.sidebar_items[line] = annotation
  end
  table.insert(lines, "")
  table.insert(lines, " c add  e edit  d delete")
  table.insert(lines, " s submit  q cancel")
  set_lines(state.sidebar_buf, lines)
end
local function render()
  local lines
  lines, state.rows = build_rows()
  set_lines(state.content_buf, lines)
  vim.api.nvim_buf_clear_namespace(state.content_buf, ns, 0, -1)
  for row_number, row in ipairs(state.rows) do
    if row.header then vim.api.nvim_buf_add_highlight(state.content_buf, ns, "DiffText", row_number - 1, 0, -1) end
    if row.line_kind == "addition" then vim.api.nvim_buf_add_highlight(state.content_buf, ns, "DiffAdd", row_number - 1, 0, -1) end
    if row.line_kind == "deletion" then vim.api.nvim_buf_add_highlight(state.content_buf, ns, "DiffDelete", row_number - 1, 0, -1) end
    if row.target then
      for _, annotation in ipairs(state.session.annotations) do
        local target = annotation.target
        if target.kind ~= "document" and row_matches(row, target) then
          local first_byte, last_byte = span_bytes(lines[row_number], target, row.line)
          if first_byte then vim.api.nvim_buf_set_extmark(state.content_buf, ns, row_number - 1, first_byte, { end_col = last_byte, hl_group = "Visual", hl_mode = "combine" }) end
          vim.api.nvim_buf_set_extmark(state.content_buf, ns, row_number - 1, 0, { virt_text = { { " ◆", "DiagnosticInfo" } }, virt_text_pos = "eol", hl_mode = "combine" })
          break
        end
      end
    end
  end
  local kind = state.session.surface.kind
  vim.bo[state.content_buf].syntax = kind == "markdown" and "markdown" or (kind == "diff" and "diff" or "")
  local document = state.session.surface.documents[state.document]
  vim.api.nvim_buf_set_name(state.content_buf, "schlop://" .. state.session.id .. "/" .. (document and document.id or "empty"))
  local document_title = (document and document.title or "no changed files"):gsub("%%", "%%%%")
  vim.wo[state.content_win].winbar = string.format(" Schlop · %s · file %d/%d%s ", document_title, math.min(state.document, #state.session.surface.documents), #state.session.surface.documents, kind == "diff" and (" · context " .. state.side) or "")
  local content_width = vim.api.nvim_win_get_width(state.content_win)
  if content_width >= 76 then
    vim.wo[state.content_win].statusline = " [f/]f files · c annotate · e edit · d delete · s submit · ? help "
  elseif content_width >= 46 then
    vim.wo[state.content_win].statusline = " [f/]f files · c annotate · s submit · ? help "
  else
    vim.wo[state.content_win].statusline = " [f/]f file · c note · s submit · ? "
  end
  render_sidebar()
end
local function rpc_session(method, params, callback)
  rpc.call(method, params, function(err, result)
    if err then return vim.notify("Schlop: " .. err.message, vim.log.levels.ERROR) end
    state.session = result
    render()
    if callback then callback() end
  end)
end
local function selected_target()
  local first, last = vim.api.nvim_win_get_cursor(0)[1], vim.api.nvim_win_get_cursor(0)[1]
  local first_col, last_col
  local mode = vim.fn.mode()
  if mode:match("[vV\22]") then
    local anchor, cursor = vim.fn.getpos("v"), vim.fn.getpos(".")
    first, last = anchor[2], cursor[2]
    first_col, last_col = anchor[3], cursor[3]
    if first > last or (first == last and first_col > last_col) then first, last, first_col, last_col = last, first, last_col, first_col end
  end
  local a, b = state.rows[first], state.rows[last]
  if not a or not b or not a.target or not b.target then error("Select addressable content lines") end
  if a.target.kind == "diff-range" and (a.hunkId ~= b.hunkId or a.side ~= b.side) then error("Diff selections must stay within one hunk and side") end
  local target = vim.deepcopy(a.target)
  target.startLine = math.min(a.line, b.line)
  target.endLine = math.max(a.line, b.line)
  -- A characterwise selection records columns so part of a line can be annotated.
  if mode == "v" and target.kind == "text-range" then
    local first_text = vim.api.nvim_buf_get_lines(0, first - 1, first, false)[1] or ""
    local last_text = vim.api.nvim_buf_get_lines(0, last - 1, last, false)[1] or ""
    local start_column = char_column(first_text, first_col)
    local end_column = char_column(last_text, math.min(last_col, math.max(#last_text, 1)))
    if not (first == last and start_column == 1 and end_column >= char_column(last_text, math.max(#last_text, 1))) then
      target.startColumn, target.endColumn = start_column, end_column
    end
  end
  return target
end
local function compose(annotation, target_override)
  local pending_target = target_override
  if not annotation and not pending_target then
    local ok, value = pcall(selected_target)
    if not ok then return vim.notify("Schlop: " .. value, vim.log.levels.ERROR) end
    pending_target = value
  end
  local width = math.max(30, math.min(72, vim.o.columns - 8))
  local height = math.max(5, math.min(12, vim.o.lines - 8))
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(annotation and annotation.body or "", "\n", { plain = true }))
  vim.bo[buf].buftype = "nofile"; vim.bo[buf].bufhidden = "wipe"; vim.bo[buf].swapfile = false; vim.bo[buf].modeline = false
  local win = vim.api.nvim_open_win(buf, true, { relative = "editor", row = math.floor((vim.o.lines - height) / 2), col = math.floor((vim.o.columns - width) / 2), width = width, height = height, style = "minimal", border = "rounded", title = " Annotation · Ctrl-s save · Esc close " })
  map(buf, { "n", "i", "s" }, "<C-s>", function()
    local body = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
    if vim.trim(body) == "" then return vim.notify("Annotation cannot be empty", vim.log.levels.WARN) end
    local params = { body = body }
    local method = "addAnnotation"
    if annotation then params.id = annotation.id; method = "updateAnnotation" else
      params.target = pending_target
    end
    vim.cmd("stopinsert")
    vim.api.nvim_win_close(win, true)
    rpc_session(method, params)
  end, "save annotation")
  map(buf, { "n", "i", "s" }, "<Esc>", function() vim.cmd("stopinsert"); vim.api.nvim_win_close(win, true) end, "close composer")
  map(buf, { "n", "i", "s" }, config.values.mappings.interrupt, function() vim.cmd("stopinsert"); vim.api.nvim_win_close(win, true); M.interrupt() end, "interrupt Schlop")
  if annotation then
    vim.api.nvim_feedkeys(vim.keycode("gg0vG$<C-g>"), "nx", false)
  else
    vim.cmd("startinsert")
  end
end
local function close_ui()
  state.closed = true
  if state.resize_group then pcall(vim.api.nvim_del_augroup_by_id, state.resize_group) end
  rpc.stop()
  if state.sidebar_win and vim.api.nvim_win_is_valid(state.sidebar_win) then pcall(vim.api.nvim_win_close, state.sidebar_win, true) end
  if state.content_win and vim.api.nvim_win_is_valid(state.content_win) then
    vim.api.nvim_set_current_win(state.content_win)
    if state.original_buf and vim.api.nvim_buf_is_valid(state.original_buf) then vim.api.nvim_win_set_buf(state.content_win, state.original_buf) end
  end
end
local function finish(method)
  if method == "cancel" and #state.session.annotations > 0 and vim.fn.confirm("Cancel and discard the current result?", "&Cancel\n&Keep reviewing", 2) ~= 1 then return end
  rpc.call(method, {}, function(err)
    if err then return vim.notify("Schlop: " .. err.message, vim.log.levels.ERROR) end
    close_ui()
    if state.standalone then vim.cmd("qa!") end
  end)
end
local function interrupt()
  rpc.call("cancel", {}, function()
    close_ui()
    if state.standalone then vim.cmd("cquit 130") end
  end)
end
M.interrupt = interrupt
local function help()
  local lines = { "Schlop", "", "j/k move · v/V select · c annotate selection · C document · A surface", "e edit · d delete · m inspected · ]a/[a annotations", "]f/[f documents · ]h/[h headings or hunks · h/l diff context side", "s submit · q cancel · Ctrl-c interrupt", "", "Persisted targets use snapshot, document, hunk, side and semantic line coordinates." }
  local buf = vim.api.nvim_create_buf(false, true); vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines); immutable(buf)
  local height = math.min(#lines + 4, vim.o.lines - 4)
  local win = vim.api.nvim_open_win(buf, true, { relative = "editor", row = math.max(1, math.floor((vim.o.lines - height) / 2)), col = math.max(1, math.floor((vim.o.columns - 78) / 2)), width = math.min(78, vim.o.columns - 4), height = height, border = "rounded", style = "minimal", title = " Help " })
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
  for _, key in ipairs({ "q", "?", "<Esc>" }) do map(buf, "n", key, function() vim.api.nvim_win_close(win, true) end, "close help") end
end
-- Resolves the annotation an action applies to, asking when the row holds several.
local function with_selected_annotation(callback)
  if vim.api.nvim_get_current_buf() == state.sidebar_buf then
    local annotation = state.sidebar_items and state.sidebar_items[vim.api.nvim_win_get_cursor(0)[1]]
    if annotation then callback(annotation) end
    return
  end
  local candidates = annotations_at_cursor()
  if #candidates == 1 then return callback(candidates[1]) end
  if #candidates == 0 then return vim.notify("Schlop: no annotation under the cursor", vim.log.levels.WARN) end
  vim.ui.select(candidates, {
    prompt = "Annotation",
    format_item = function(annotation) return (annotation.body:gsub("\n.*", "")) end,
  }, function(choice) if choice then callback(choice) end end)
end
local function jump_landmark(delta)
  local document = state.session.surface.documents[state.document]
  if not document then return end
  local landmarks = {}
  if state.session.surface.kind == "markdown" then
    for _, heading in ipairs(document.headings) do table.insert(landmarks, heading.line) end
  elseif state.session.surface.kind == "diff" then
    for row, item in ipairs(state.rows) do if item.header then table.insert(landmarks, row) end end
  end
  if #landmarks == 0 then return end
  local current = vim.api.nvim_win_get_cursor(state.content_win)[1]
  if delta > 0 then
    for _, row in ipairs(landmarks) do if row > current then vim.api.nvim_win_set_cursor(state.content_win, { row, 0 }); return end end
    vim.api.nvim_win_set_cursor(state.content_win, { landmarks[1], 0 })
  else
    for index = #landmarks, 1, -1 do if landmarks[index] < current then vim.api.nvim_win_set_cursor(state.content_win, { landmarks[index], 0 }); return end end
    vim.api.nvim_win_set_cursor(state.content_win, { landmarks[#landmarks], 0 })
  end
end
local function jump_annotation(delta)
  if #state.session.annotations == 0 then return end
  state.annotation_index = ((state.annotation_index or (delta > 0 and 0 or 2)) - 1 + delta) % #state.session.annotations + 1
  local annotation = state.session.annotations[state.annotation_index]
  if annotation.target.documentId then
    for index, document in ipairs(state.session.surface.documents) do if document.id == annotation.target.documentId then state.document = index end end
    render()
    for row, item in ipairs(state.rows) do
      local target = annotation.target
      if (target.kind == "text-range" and item.line == target.startLine) or (target.kind == "diff-range" and item.hunkId == target.hunkId and item.side == target.side and item.line == target.startLine) then vim.api.nvim_win_set_cursor(state.content_win, { row, 0 }); break end
    end
  end
end
local function setup_mappings(buf)
  local m = config.values.mappings
  map(buf, { "n", "x" }, m.annotate, function() compose(nil) end, "annotate")
  map(buf, "n", "C", function() local document = state.session.surface.documents[state.document]; if document then compose(nil, { kind = "document", surfaceSnapshotId = state.session.surface.snapshotId, documentId = document.id }) end end, "annotate document")
  map(buf, "n", "A", function() compose(nil, { kind = "surface", surfaceSnapshotId = state.session.surface.snapshotId }) end, "annotate surface")
  map(buf, "n", m.edit, function() with_selected_annotation(compose) end, "edit annotation")
  map(buf, "n", m.delete, function()
    with_selected_annotation(function(a)
      if vim.fn.confirm("Delete annotation?", "&Delete\n&Keep", 2) == 1 then rpc_session("deleteAnnotation", { id = a.id }) end
    end)
  end, "delete annotation")
  map(buf, "n", m.inspected, function() local document = state.session.surface.documents[state.document]; if document then rpc_session("setInspected", { documentId = document.id, inspected = not vim.tbl_contains(state.session.progress.inspectedDocumentIds, document.id) }) end end, "toggle inspected")
  map(buf, "n", m.next_annotation, function() jump_annotation(1) end, "next annotation")
  map(buf, "n", m.previous_annotation, function() jump_annotation(-1) end, "previous annotation")
  map(buf, "n", m.next_document, function() local count = #state.session.surface.documents; if count > 0 then state.document = state.document % count + 1; render() end end, "next document")
  map(buf, "n", m.previous_document, function() local count = #state.session.surface.documents; if count > 0 then state.document = (state.document - 2) % count + 1; render() end end, "previous document")
  map(buf, "n", "]h", function() jump_landmark(1) end, "next heading or hunk")
  map(buf, "n", "[h", function() jump_landmark(-1) end, "previous heading or hunk")
  map(buf, "n", "h", function() if state.session.surface.kind == "diff" then state.side = "old"; render() else vim.cmd("normal! h") end end, "old side")
  map(buf, "n", "l", function() if state.session.surface.kind == "diff" then state.side = "new"; render() else vim.cmd("normal! l") end end, "new side")
  map(buf, "n", m.submit, function() finish("submit") end, "submit")
  map(buf, "n", m.cancel, function() finish("cancel") end, "cancel")
  map(buf, "n", m.help, help, "help")
  map(buf, "n", m.interrupt, interrupt, "interrupt Schlop")
  map(buf, "n", "<Tab>", "<C-w>w", "next pane")
  map(buf, "n", "<S-Tab>", "<C-w>W", "previous pane")
  vim.api.nvim_create_autocmd("BufWriteCmd", { buffer = buf, callback = function() vim.notify("Schlop surfaces are immutable", vim.log.levels.WARN) end })
end
local function update_layout()
  local sidebar_valid = state.sidebar_win and vim.api.nvim_win_is_valid(state.sidebar_win)
  if vim.o.columns < 70 and sidebar_valid then
    if vim.api.nvim_get_current_win() == state.sidebar_win then vim.api.nvim_set_current_win(state.content_win) end
    pcall(vim.api.nvim_win_close, state.sidebar_win, true)
    state.sidebar_win = nil
    state.sidebar_buf = nil
    return
  end
  if vim.o.columns >= 70 and not sidebar_valid then
    local previous = vim.api.nvim_get_current_win()
    vim.api.nvim_set_current_win(state.content_win)
    vim.cmd("botright 30vnew")
    state.sidebar_win = vim.api.nvim_get_current_win()
    state.sidebar_buf = vim.api.nvim_get_current_buf()
    immutable(state.sidebar_buf)
    vim.wo[state.sidebar_win].number = false
    vim.wo[state.sidebar_win].relativenumber = false
    vim.wo[state.sidebar_win].signcolumn = "no"
    vim.wo[state.sidebar_win].foldcolumn = "0"
    vim.wo[state.sidebar_win].wrap = true
    setup_mappings(state.sidebar_buf)
    if vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
  end
end
M.finish = finish
function M.open(session, options)
  state = { session = session, document = 1, side = "new", standalone = options and options.standalone or false, original_win = vim.api.nvim_get_current_win(), original_buf = vim.api.nvim_get_current_buf(), closed = false }
  state.content_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_win_set_buf(0, state.content_buf); state.content_win = vim.api.nvim_get_current_win(); immutable(state.content_buf)
  setup_mappings(state.content_buf)
  update_layout()
  state.resize_group = vim.api.nvim_create_augroup("SchlopResize", { clear = true })
  vim.api.nvim_create_autocmd("VimResized", { group = state.resize_group, callback = function()
    if state.closed then return end
    update_layout()
    render()
  end })
  render()
end
return M
