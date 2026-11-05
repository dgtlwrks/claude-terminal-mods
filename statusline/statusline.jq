# Draws the status line: resolves the layout's statusLine rows against the input and prints one string per row.
# Input (stdin): Claude Code's status line JSON. Arguments: --slurpfile layout <file>, --arg cwd / branch / mark
# (those three come from the shell: zsh prompt expansion and git).
# Layout resolution is a port of resolveLine() in checklist/hooks/layout.ts; keep the two in step.
# Runs on jq 1.7 (macOS /usr/bin/jq): no string repetition, no trim, no abs.

. as $in

# --- Layout normalisation (mirrors element(), line(), styles() in layout.ts) ---------------------------------------
| def arr: if type == "array" then . else [] end;
  def str($d): if type == "string" then . else $d end;
  def num($d; $max): if type == "number" then (round | if . < 0 then 0 elif . > $max then $max else . end) else $d end;
  def styles: arr | map(select(type == "string" and IN("g", "y", "r", "c", "m", "dim", "b", "u", "tagel", "spacer")));
  def obj: if type == "object" then . else {} end;
  def rep($s; $n): [range(0; $n) | $s] | join("");

  def element:
    obj as $e
    | { key: ($e.key | str("text")),
        text: (if ($e.text | type) == "string" then $e.text else null end),
        segments: (if ($e.segments | type) == "array"
                   then $e.segments | map(obj | {text: (.text | str("")), style: (.style | styles)})
                   else null end),
        style: ($e.style | styles),
        space: ($e.spaceBefore | num(1; 12)),
        width: ($e.width | num(0; 40)),
        right: ($e.align == "right") };

# --- Data catalog -----------------------------------------------------------------------------------------------------
# Input fields may be absent or of the wrong type; control characters are dropped from every string so
# nothing in a session name or URL can inject terminal escapes.
  def at($p): try ($in | getpath($p)) catch null;
  def numv($p): at($p) | if type == "number" then . else null end;
  def strv($p): at($p) | if type == "string" then gsub("\\p{Cc}"; "") else "" end;
  def v($t; $s): {text: $t, style: $s};
  def E: v(""; []);
  def level($p): if $p >= 90 then ["r"] elif $p >= 70 then ["y"] else ["g"] end;
  # OSC 8 hyperlink: Cmd+click opens the URL in terminals that support it.
  def link($url; $text): "\u001b]8;;\($url)\u001b\\\($text)\u001b]8;;\u001b\\";
  # 226000 -> "226k", 1000000 -> "1M", 1250000 -> "1.3M"
  def tok:
    floor as $n
    | if $n >= 1000000 then
        if $n % 1000000 == 0 then "\($n / 1000000)M"
        else (($n / 100000) | round) as $r | "\($r / 10 | floor).\($r % 10)M" end
      elif $n >= 1000 then "\(($n / 1000) | round)k"
      else "\($n)" end;
  def two: tostring | if length < 2 then "0" + . else . end;

  def data:
    (numv(["context_window", "used_percentage"]) // 0 | floor) as $pct
    | (numv(["context_window", "context_window_size"]) // 0) as $win
    | (numv(["cost", "total_lines_added"]) // 0 | floor) as $add
    | (numv(["cost", "total_lines_removed"]) // 0 | floor) as $del
    | (numv(["cost", "total_cost_usd"]) // 0) as $cost
    | ((numv(["cost", "total_duration_ms"]) // 0) / 1000 | floor) as $s
    | (numv(["rate_limits", "five_hour", "used_percentage"])) as $fh
    | (numv(["rate_limits", "seven_day", "used_percentage"])) as $wk
    | (numv(["rate_limits", "five_hour", "resets_at"])) as $fhAt
    | (numv(["rate_limits", "seven_day", "resets_at"])) as $wkAt
    | (at(["prompt_cache", "warm"])) as $warm
    | ((numv(["prompt_cache", "hit_ratio"]) // 0) * 100 | floor) as $h
    | ((((numv(["prompt_cache", "expires_at"]) // now) - now) / 60 | floor) | if . < 0 then 0 else . end) as $m
    | (strv(["workspace", "repo", "owner"])) as $owner
    | (strv(["workspace", "repo", "name"])) as $rname
    | (at(["pr", "number"])) as $prn
    | (([$pct / 10 | floor, 10] | min) | if . < 0 then 0 else . end) as $filled
    | {
        "model": v(strv(["model", "display_name"]); []),
        "effort": v(strv(["effort", "level"]); []),
        "cwd": v($ARGS.named.cwd; []),
        "branch": v($ARGS.named.branch; []),
        "git.mark": v($ARGS.named.mark; []),
        "diff.add": (if $add + $del > 0 then v("+\($add)"; []) else E end),
        "diff.del": (if $add + $del > 0 then v("−\($del)"; []) else E end),
        "ctx.bar": v(rep("█"; $filled) + rep("░"; 10 - $filled); level($pct)),
        "ctx.pct": v("\($pct)%"; []),
        "ctx.tokens": (if $win > 0 then v("\(numv(["context_window", "total_input_tokens"]) // 0 | tok)/\($win | tok)"; []) else E end),
        "cost": v("$\(($cost * 100 | round) as $r | "\($r / 100 | floor).\($r % 100 | two)")"; []),
        "duration": v(if $s >= 3600 then "\($s / 3600 | floor)h \($s % 3600 / 60 | floor)m"
                      else "\($s / 60 | floor)m \($s % 60)s" end; []),
        "limit.5h": (if $fh != null then v("5h \($fh | floor)%"; level($fh)) else E end),
        "limit.5h.reset": (if $fhAt != null then v("↻\($fhAt | strflocaltime("%H:%M"))"; []) else E end),
        "limit.week": (if $wk != null then v("wk \($wk | floor)%"; level($wk)) else E end),
        "limit.week.reset": (if $wkAt != null then v("↻\($wkAt | strflocaltime("%a %H:%M"))"; []) else E end),
        "session.name": v(strv(["session_name"]); []),
        "cache": (if $warm == true then v("⚡ cache warm \($h)% hit, cold in \($m)m"; [])
                  elif $warm == false then v("❄ cache cold"; ["dim"])
                  else E end),
        "cache.hit": (if $warm == true then v("cache warm \($h)% hit"; []) else E end),
        "cache.cold": (if $warm == true then v("cold in \($m)m"; [])
                       elif $warm == false then v("cache cold"; ["dim"])
                       else E end),
        "repo": (if $owner != "" then v(link("https://github.com/\($owner)/\($rname)"; if $rname != "" then "\($owner)/\($rname)" else $owner end); []) else E end),
        "pr": (if ($prn | type) == "number" then
                 strv(["pr", "url"]) as $url | strv(["pr", "review_state"]) as $state
                 | (if $url != "" then link($url; "PR #\($prn)") else "PR #\($prn)" end) as $t
                 | v($t + (if $state != "" then " " + $state else "" end); [])
               else E end)
      };

# --- Resolution (resolveLine in layout.ts) ----------------------------------------------------------------------------
  def LITERALS: ["text", "sep", "emoji", "mark", "spacer", "badge", "rule", "bar", "spark", "meter"];
  # Columns: pictographs (U+1F000 and up) take two, joiners and variation selectors none.
  # Same rule as width() in the mods' layout.ts: two columns for an emoji drawn as one (U+1F000 and up, the
  # Emoji_Presentation list below, or a character followed by U+FE0F), none for joiners and selectors, one otherwise.
  def cols: explode as $c | [range(0; $c | length) as $i | $c[$i] as $cp
    | if $cp == 8205 or $cp == 65038 or $cp == 65039 then 0
      elif $cp >= 126976 or $c[$i + 1] == 65039 or ([[8986,8987], [9193,9196], [9200,9200], [9203,9203], [9725,9726], [9748,9749], [9800,9811], [9855,9855], [9875,9875], [9889,9889], [9898,9899], [9917,9918], [9924,9925], [9934,9934], [9940,9940], [9962,9962], [9970,9971], [9973,9973], [9978,9978], [9981,9981], [9989,9989], [9994,9995], [10024,10024], [10060,10060], [10062,10062], [10067,10069], [10071,10071], [10133,10135], [10160,10160], [10175,10175], [11035,11036], [11088,11088], [11093,11093]] | any(.[0] <= $cp and $cp <= .[1])) then 2
      else 1 end] | add // 0;
  def popicons:
    if length > 0 and (.[-1] | (.sep | not) and (.data | not) and (.el.key | IN("emoji", "mark")))
    then .[:-1] | popicons else . end;
  def popsep: if length > 0 and .[-1].sep then .[:-1] else . end;

  def items($data):
    reduce .elements[] as $el ([];
      if ($el.key | IN(LITERALS[])) then
        . + [{el: $el, sep: ($el.key == "sep"), data: false,
              pieces: (if $el.segments != null
                       then $el.segments | map({text: .text, style: ($el.style + .style)})
                       else [{text: ($el.text // ""), style: $el.style}] end)}]
      else
        ($data[$el.key] // E) as $val
        | if $val.text == "" then
            # An empty data element keeps its blank cells when it has a width; otherwise it takes its icons and one separator with it.
            if $el.width > 0 then . + [{el: $el, sep: false, data: false, pieces: [{text: "", style: []}]}]
            else popicons | popsep end
          else
            . + [{el: $el, sep: false, data: true,
                  pieces: [{text: $val.text, style: (if ($el.style | length) > 0 then $el.style else $val.style end)}]}]
          end
      end);

  # Runs between separators; a separator is drawn only between two runs that each hold a data element.
  def keep:
    (reduce .[] as $it ([{sep: null, items: []}];
       if $it.sep then . + [{sep: $it, items: []}] else .[-1].items += [$it] end)) as $runs
    | (reduce $runs[] as $run ({kept: [], prev: null};
         if ($run.items | length) == 0 then .
         else ($run.items | any(.data)) as $h
           | (if $run.sep != null and .prev == true and $h then .kept += [$run.sep] else . end)
           | .kept += $run.items
           | .prev = $h
         end)).kept;

  def layout:
    to_entries
    | map(.key as $i | .value as $it
        | ($it.pieces | map(.text | cols) | add // 0) as $drawn
        | (if $it.el.width > $drawn then rep(" "; $it.el.width - $drawn) else "" end) as $pad
        | (if $i == 0 then 0 else $it.el.space end) as $sp
        | (if $sp > 0 then [{text: rep(" "; $sp), style: []}] else [] end)
          + (if $pad != "" and $it.el.right then [{text: $pad, style: []}] else [] end)
          + ($it.pieces | map(select(.text != "")))
          + (if $pad != "" and ($it.el.right | not) then [{text: $pad, style: []}] else [] end))
    | add // [];

  # Cuts trailing whitespace, dropping pieces that end up empty.
  def trimtail:
    if length == 0 then .
    else (length - 1) as $i | .[$i].text |= sub("\\s+$"; "")
      | if .[$i].text == "" then .[:$i] | trimtail else . end
    end;

# --- Drawing ----------------------------------------------------------------------------------------------------------
  def SGR: {g: "32", y: "33", r: "31", c: "36", m: "35", dim: "2", b: "1", u: "4", tagel: "7"};
  def draw:
    (.style | map(SGR[.] // empty) | join(";")) as $c
    | if $c == "" then .text else "\u001b[\($c)m\(.text)\u001b[0m" end;

  data as $data
| ($layout[0] | obj | .statusLine | arr)[]
| {elements: (obj | .elements | arr | map(element))}
| items($data) | keep | layout | trimtail
| select(length > 0)
| map(draw) | join("")
