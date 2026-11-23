-- Renders a Markdown surface in place: the buffer keeps the source lines, so
-- every annotation still anchors to a source line and column, and the reading
-- view is drawn on top with Neovim's own Markdown tree-sitter highlighting
-- and conceal, plus extmarks for what that leaves raw (heading markers,
-- bullets, rules, quotes, task boxes, table borders, code block shading).
-- The cursor line shows its raw source, so selections stay exact.
local M = {}
local ns = vim.api.nvim_create_namespace("schlop_markdown")

vim.api.nvim_set_hl(0, "SchlopMdH1", { default = true, link = "@markup.heading.1" })
vim.api.nvim_set_hl(0, "SchlopMdH2", { default = true, link = "@markup.heading.2" })
vim.api.nvim_set_hl(0, "SchlopMdH3", { default = true, link = "@markup.heading.3" })
vim.api.nvim_set_hl(0, "SchlopMdH4", { default = true, link = "@markup.heading.4" })
vim.api.nvim_set_hl(0, "SchlopMdH5", { default = true, link = "@markup.heading.5" })
vim.api.nvim_set_hl(0, "SchlopMdH6", { default = true, link = "@markup.heading.6" })
vim.api.nvim_set_hl(0, "SchlopMdHeadingLine", { default = true, link = "CursorLine" })
vim.api.nvim_set_hl(0, "SchlopMdCode", { default = true, link = "ColorColumn" })
vim.api.nvim_set_hl(0, "SchlopMdMarker", { default = true, link = "@markup.list" })
vim.api.nvim_set_hl(0, "SchlopMdRule", { default = true, link = "WinSeparator" })

local heading_icons = { "█ ", "▊ ", "▋ ", "▌ ", "▍ ", "▎ " }

local query
local function markdown_query()
  if query == nil then
    local ok, parsed = pcall(vim.treesitter.query.parse, "markdown", [[
      (atx_heading) @heading
      (list_item [(list_marker_minus) (list_marker_plus) (list_marker_star)] @task_bullet . [(task_list_marker_unchecked) (task_list_marker_checked)])
      (list_marker_minus) @bullet
      (list_marker_plus) @bullet
      (list_marker_star) @bullet
      (thematic_break) @rule
      (block_quote_marker) @quote
      (task_list_marker_unchecked) @unchecked
      (task_list_marker_checked) @checked
      (fenced_code_block) @code
      (pipe_table) @table
    ]])
    query = ok and parsed or false
  end
  return query or nil
end

local function overlay(buf, row, col, end_col, text, hl)
  vim.api.nvim_buf_set_extmark(buf, ns, row, col, { end_col = end_col, conceal = "", virt_text = { { text, hl } }, virt_text_pos = "inline", priority = 120 })
end

-- Redraws a pipe table with box-drawing borders and padded columns. Cells
-- keep their source text; only borders and padding are virtual.
local function table_(buf, node)
  local rows, widths = {}, {}
  for child in node:iter_children() do
    local kind = child:type()
    if kind == "pipe_table_header" or kind == "pipe_table_row" or kind == "pipe_table_delimiter_row" then
      local row = { node = child, delimiter = kind == "pipe_table_delimiter_row", cells = {} }
      for cell in child:iter_children() do
        local cell_kind = cell:type()
        if cell_kind == "pipe_table_cell" or cell_kind == "pipe_table_delimiter_cell" then
          local text = vim.treesitter.get_node_text(cell, buf)
          local shown = text:gsub("%*%*", ""):gsub("`", ""):gsub("%[([^%]]*)%]%b()", "%1")
          table.insert(row.cells, { node = cell, width = row.delimiter and 0 or vim.fn.strdisplaywidth(vim.trim(shown)) })
          local index = #row.cells
          widths[index] = math.max(widths[index] or 1, row.cells[index].width)
        end
      end
      table.insert(rows, row)
    end
  end
  for _, row in ipairs(rows) do
    local line, start_col = row.node:range()
    local text = vim.api.nvim_buf_get_lines(buf, line, line + 1, false)[1] or ""
    if row.delimiter then
      local parts = {}
      for index = 1, #widths do parts[index] = string.rep("─", widths[index] + 2) end
      overlay(buf, line, start_col, #text, "├" .. table.concat(parts, "┼") .. "┤", "SchlopMdRule")
    else
      -- Each source segment "| cell " becomes "│ cell<padding> ".
      local cursor = start_col
      for index, cell in ipairs(row.cells) do
        local _, cell_start, _, cell_end = cell.node:range()
        overlay(buf, line, cursor, cell_start, "│ ", "SchlopMdRule")
        local _, trimmed_end = vim.trim(vim.treesitter.get_node_text(cell.node, buf)), cell_end
        local raw = vim.api.nvim_buf_get_text(buf, line, cell_start, line, cell_end, {})[1] or ""
        trimmed_end = cell_start + #(raw:gsub("%s+$", ""))
        local padding = string.rep(" ", (widths[index] or 0) - cell.width + 1)
        local next_cell = row.cells[index + 1]
        local stop = next_cell and select(2, next_cell.node:range()) or #text
        if next_cell then
          overlay(buf, line, trimmed_end, trimmed_end, padding, "Normal")
          cursor = trimmed_end
        else
          overlay(buf, line, trimmed_end, stop, padding .. "│", "SchlopMdRule")
        end
      end
    end
  end
end

local function decorate(buf, win)
  local ok, parser = pcall(vim.treesitter.get_parser, buf, "markdown")
  local q = markdown_query()
  if not ok or not parser or not q then return end
  local tree = parser:parse()[1]
  if not tree then return end
  local width = vim.api.nvim_win_get_width(win)
  local tasks = {}
  for id, node in q:iter_captures(tree:root(), buf, 0, -1) do
    local name = q.captures[id]
    local row, col, end_row, end_col = node:range()
    if name == "heading" then
      local marker = node:child(0)
      local level = marker and tonumber(marker:type():match("atx_h(%d)_marker")) or 1
      local _, _, _, marker_end = marker:range()
      local text = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
      local stop = text:sub(marker_end + 1, marker_end + 1) == " " and marker_end + 1 or marker_end
      overlay(buf, row, col, stop, heading_icons[level], "SchlopMdH" .. level)
      vim.api.nvim_buf_set_extmark(buf, ns, row, 0, { line_hl_group = "SchlopMdHeadingLine", priority = 10 })
    elseif name == "task_bullet" then
      tasks[row] = true
      overlay(buf, row, col, end_col, "", "SchlopMdMarker")
    elseif name == "bullet" then
      if not tasks[row] then overlay(buf, row, col, col + 1, "•", "SchlopMdMarker") end
    elseif name == "rule" then
      vim.api.nvim_buf_set_extmark(buf, ns, row, col, { virt_text = { { string.rep("─", width), "SchlopMdRule" } }, virt_text_pos = "overlay", priority = 120 })
    elseif name == "quote" then
      overlay(buf, row, col, col + 1, "▎", "@markup.quote")
    elseif name == "unchecked" then
      overlay(buf, row, col, end_col, "☐", "SchlopMdMarker")
    elseif name == "checked" then
      overlay(buf, row, col, end_col, "☑", "@markup.list.checked")
    elseif name == "code" then
      for line = row, math.max(row, end_row - (end_col == 0 and 1 or 0)) do
        vim.api.nvim_buf_set_extmark(buf, ns, line, 0, { line_hl_group = "SchlopMdCode", priority = 10 })
      end
    elseif name == "table" then
      table_(buf, node)
    end
  end
end

-- Draws `buf` in `win` as rendered Markdown, or as raw source when
-- `rendered` is false. Safe to call after every redraw of the buffer.
function M.apply(buf, win, rendered)
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  if not rendered then
    pcall(vim.treesitter.stop, buf)
    vim.bo[buf].syntax = "markdown"
    vim.wo[win].conceallevel = 0
    return false
  end
  vim.bo[buf].syntax = ""
  if not pcall(vim.treesitter.start, buf, "markdown") then
    vim.bo[buf].syntax = "markdown"
    return false
  end
  vim.wo[win].conceallevel = 2
  vim.wo[win].concealcursor = "nc"
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  vim.wo[win].breakindent = true
  pcall(decorate, buf, win)
  return true
end

function M.clear(buf, win)
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  pcall(vim.treesitter.stop, buf)
  if win and vim.api.nvim_win_is_valid(win) then vim.wo[win].conceallevel = 0 end
end

return M
