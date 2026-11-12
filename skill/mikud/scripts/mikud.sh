#!/bin/sh
# mikud for agents without Node 20+: POSIX sh and curl, with awk, od and the other POSIX tools.
#
# One of three versions with one contract (see mikud.mjs): same commands, same one-line JSON answers and error codes,
# the same files and the same lock, so they can run side by side on one computer. No secret ever appears in the
# output.
#
# Secrets (the session token, the device code, the agent key) stay in shell variables. A request that carries one hands
# its headers and body to curl on its standard input (printf is built into the shell, so they are on no command line),
# and the answer is read from curl's standard output into a variable: never a file, an argument or the environment of
# another program. Only `connection` and `pending` keep a secret.
#
# Record fields are read and written through eval, as <PREFIX><field> variables, and with_lock runs the steps it is
# given by name.
# shellcheck disable=SC2034,SC2154,SC2317
set -u
set -f
umask 077
# Every name this script assigns is unset here, before anything else runs: one that the caller exported would keep its
# export when assigned, and so reach the environment of curl, awk and every other program this script starts, a secret
# among them. The contract test fails when a name the script assigns is missing here.
unset BODY BODYTEXT BREAKER CF_FOUND CLIENT_ID COMMAND CONNECTION CS_expiresAt CS_keyName CS_origin DAYS DEVICE_GRANT
unset DIR DONE ENDED E_BODY E_CODE E_MSG E_SENT E_STATUS HOME_FOUND HOST HOST_LOWER INT JF JK JSON_OK JV LABEL LEFT
unset LEFT_FILE LN_keyName LN_origin LOCK LOCKTOKEN L_found L_sessionOpen MYUID NK_found NK_noKey N_attemptId
unset N_codeExpiresAt N_days N_interval N_keyName N_keySaved N_link N_nextPollAt N_noKey N_origin N_phase
unset N_pollInFlight N_sessionOpen N_uncertain N_userCode N_v OPT_AS OPT_AS_SET OPT_CLEAR OPT_DAYS OPT_DAYS_SET
unset OPT_JSON OPT_JSONFILE OPT_JSONFILE_SET OPT_JSON_SET OPT_REPLACE OPT_URL OPT_WAIT ORIGIN OS OW_STATE OW_pid
unset O_found PENDING POS1 POS_COUNT P_found P_interval P_nextPollAt P_pollInFlight P_uncertain QQ Q_found Q_keySaved
unset RESULT RP_FOUND RP_TEXT R_found R_phase R_pollInFlight R_sessionOpen SECURED SER SETTLE_WARN SN_found START
unset STATE_ID STATUS STEP_WAIT ST_MODE ST_UID TARGET TMPFILE TOKEN UA UP UP_extra UP_host UP_origin UP_scheme VERDICT
unset WARN WORG W_expiresAt W_keyName W_origin W_v _n al_now al_rows ap_hasq ap_ok ap_part ap_query ap_rest ap_tail
unset ap_v aq_deadline aq_owner aq_r aq_token aw_kn aw_ks aw_nk aw_pf aw_ph aw_so aw_un bl_rc bl_token bo_set ca_lost
unset ca_set ca_then cl_dc cl_found cl_found_origin cl_interval cl_link cl_origin cl_t cl_uc cl_ucok cs_key cs_n cs_o
unset cs_ok cs_x cw_until hf_body hf_detail hf_p hk_at hk_i io_abs io_int jg_line jg_rest js_q json_mode kn_raw
unset lb_hand lo_ok mn_line pa pa_c pa_l pa_o pa_x pe_left pe_out pl_rows qq_s ra_rows ra_seen ra_w ra_warn rc_found
unset rc_k rc_n rc_o rcl_f rcp_f rd_ended rd_id rd_name rd_ok rd_origin rd_saved rl_rows ro_pid ro_row ro_text rp_d
unset rp_found rp_i rp_o rp_p rq_out rq_rc rq_why rr_row rs_a rs_b rs_f rv_f rv_rest rv_v so_ls so_stat st_finished
unset st_k st_left st_o st_out st_w st_x sw_f sw_h sw_n sz_f sz_k sz_sep sz_v uf_k uf_o uf_s up_auth up_host up_port
unset up_r up_s up_tail util_mode wl_rc wl_text ws_err ws_rc ws_t
# Names made from a prefix (eval): the secret fields of every record, and every kept failure.
for _p in C_ K_ L_ LN_ N_ NK_ O_ OW_ P_ Q_ R_ RA_ SN_ V_ W_ X_ Y_; do unset "${_p}key" "${_p}deviceCode"; done
for _p in S F H; do unset "${_p}_code" "${_p}_msg" "${_p}_status" "${_p}_body" "${_p}_sent"; done
unset _p

CLIENT_ID=mikud-connect
DEVICE_GRANT=urn:ietf:params:oauth:grant-type:device_code
NL='
'
TAB=$(printf '\t')
# Control characters and DEL: never in a stored value (mikud.mjs's PLAIN rule).
CTL=$(printf '\001\002\003\004\005\006\007\010\011\012\013\014\015\016\017\020\021\022\023\024\025\026\027\030\031\032\033\034\035\036\037\177')
LOWER=abcdefghijklmnopqrstuvwxyz
UPPER=ABCDEFGHIJKLMNOPQRSTUVWXYZ
DIGIT=0123456789
# Characters a query may hold as typed (RFC 3986's query set without the apostrophe), and those of an agent label.
QUERY_CH='._~!$&()*+,;=:@/?%-'
LABEL_CH=' ._:-'
HEX_='[0123456789abcdef]'
UUID="$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_-$HEX_$HEX_$HEX_$HEX_-$HEX_$HEX_$HEX_$HEX_-$HEX_$HEX_$HEX_$HEX_-$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_$HEX_"

# whole VALUE FALLBACK: a positive whole number, or the fallback.
whole() {
  case ${1:-} in
    [123456789]*) case $1 in *[!$DIGIT]*) printf '%s' "$2" ;; *) if [ ${#1} -le 15 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi ;; esac ;;
    *) printf '%s' "$2" ;;
  esac
}
WAIT_SECONDS=$(whole "${MIKUD_WAIT_SECONDS:-}" 90)
# Test seams: the tests shorten the lock wait and the request timeout, and move the clock forward.
LOCK_WAIT_MS=$(whole "${MIKUD_TEST_LOCK_WAIT_MS:-}" 20000)
TIMEOUT_MS=$(whole "${MIKUD_TEST_TIMEOUT_MS:-}" 15000)
CLOCK_OFFSET=$(whole "${MIKUD_TEST_CLOCK_OFFSET:-}" 0)
TIMEOUT_S="$((TIMEOUT_MS / 1000)).$(printf '%03d' $((TIMEOUT_MS % 1000)))"

CONN_FIELDS="v:n origin:s key:s keyName:s expiresAt:s"
PEND_FIELDS="v:n attemptId:s origin:s deviceCode:s userCode:s link:s interval:n nextPollAt:n codeExpiresAt:n days:n keyName:s phase:s pollInFlight:n uncertain:n sessionOpen:n keySaved:n noKey:n"
LEFT_FIELDS="origin:s keyName:s expiresAt:s reason:s at:s"
OWNER_FIELDS="token:s host:s pid:n start:s"

SESSION_TEXT="Mikud may have opened a 'mikud connect (agent approval)' session that was not ended: end it on the Account page."

HELP="mikud: keep the owner's Mikud board current, after the owner approves this computer user once.

  connect [--url <address>] [--days <1-365>] [--replace]
                          Ask to connect; prints a link and a code to show the owner.
  connect --wait --url <address>
                          Wait up to $WAIT_SECONDS s for the approval; run again while it answers still_waiting.
  status [--clear-left]   Whether this computer user is connected, and what the command left on Mikud (no secrets).
  disconnect              Forget the connection on this computer (the key stays on Mikud until it ends).
  get '<path>'            GET /api/v1/<path>, for example: get 'items?q=login'
  post '<path>' --json '<body>' | --json-file <file>
  patch '<path>' --json '<body>' | --json-file <file>
                          --as <label> (or MIKUD_AGENT_LABEL) names the agent in Mikud's activity log."

# A small JSON reader, as strict as JSON.parse. Input on standard input (a pipe: it may hold a secret). Modes:
#   valid    exit 0 when the input is one JSON value
#   fields   one line per value of the top object and of its objects: 1 TAB path TAB kind TAB value (kinds: s string,
#            c string that held control characters (left out), n number, t true, f false, z null, o object, a array)
#   rows     for each top value (one per line in a file), its kind and the keys (-v keys="name:s name:n ...") TAB
#            separated
#   compact  the value without white space
#   answer   Mikud's answer next to its HTTP status (-v status=...): {"status":..., ...the answer's fields} when it
#            holds data, else {"status":..., "data": <answer or null>}
# shellcheck disable=SC2016 # awk's own fields
JSON_AWK='
function rep(s, from, to,   r, k) {
  r = ""
  while ((k = index(s, from)) > 0) { r = r substr(s, 1, k - 1) to; s = substr(s, k + length(from)) }
  return r s
}
function hexval(h,   i, v) {
  v = 0; h = tolower(h)
  for (i = 1; i <= 4; i++) v = v * 16 + index("0123456789abcdef", substr(h, i, 1)) - 1
  return v
}
function ishex4(h) { return h ~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$/ }
function utf8(c) {
  if (c < 128) return sprintf("%c", c)
  if (c < 2048) return sprintf("%c%c", 192 + int(c / 64), 128 + c % 64)
  if (c < 65536) return sprintf("%c%c%c", 224 + int(c / 4096), 128 + int(c / 64) % 64, 128 + c % 64)
  return sprintf("%c%c%c%c", 240 + int(c / 262144), 128 + int(c / 4096) % 64, 128 + int(c / 64) % 64, 128 + c % 64)
}
function decode(s,   out, k, c, cp, lo) {
  ctl = 0
  if (index(s, "\t") || index(s, "\n") || index(s, "\r")) { bad = 1; return "" }
  out = ""
  while ((k = index(s, "\\")) > 0) {
    out = out substr(s, 1, k - 1); c = substr(s, k + 1, 1); s = substr(s, k + 2)
    if (c == "/") out = out "/"
    else if (c == "b" || c == "f" || c == "n" || c == "r" || c == "t") ctl = 1
    else if (c == "u" && ishex4(substr(s, 1, 4))) {
      cp = hexval(substr(s, 1, 4)); s = substr(s, 5)
      if (cp >= 55296 && cp < 56320) {
        lo = -1
        if (substr(s, 1, 2) == "\\u" && ishex4(substr(s, 3, 4))) lo = hexval(substr(s, 3, 4))
        if (lo >= 56320 && lo < 57344) { cp = 65536 + (cp - 55296) * 1024 + lo - 56320; s = substr(s, 7) }
        else cp = 65533
      } else if (cp >= 56320 && cp < 57344) cp = 65533
      if (cp < 32 || cp == 127) ctl = 1
      else out = out utf8(cp)
    } else { bad = 1; return "" }
  }
  out = out s
  if (index(out, DEL)) ctl = 1
  return rep(rep(out, BS, "\\"), QT, "\"")
}
function lit(   v) {
  v = word; word = ""
  if (v == "true" || v == "false" || v == "null") { T[++nt] = "l"; V[nt] = v }
  else if (v ~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/) { T[++nt] = "n"; V[nt] = v }
  else bad = 1
}
function out(path, kind, value) {
  if (mode == "fields") print rec "\t" path "\t" kind "\t" value
  else if (mode == "rows" && index(path, ".") == 0) { RK[path] = kind; RV[path] = value }
}
function parse(path, depth, emit,   t, k, kc, kt, child) {
  if (bad) return
  if (ti > nt) { bad = 1; return }
  t = T[ti]
  if (t == "{") {
    if (emit && path != "") out(path, "o", "")
    ti++
    if (T[ti] == "}") { ti++; return }
    for (;;) {
      if (T[ti] != "s") { bad = 1; return }
      kt = ti; k = decode(P[V[ti]]); kc = ctl
      if (bad) return
      ti++
      if (T[ti] != ":") { bad = 1; return }
      ti++
      if (depth == 0) { nm++; MK[nm] = k; MT[nm] = kt; MS[nm] = ti }
      child = path == "" ? k : path "." k
      parse(child, depth + 1, emit && depth < 2 && !kc && k ~ /^[A-Za-z_][A-Za-z0-9_]*$/)
      if (bad) return
      if (depth == 0) ME[nm] = ti - 1
      if (T[ti] == ",") { ti++; continue }
      if (T[ti] == "}") { ti++; return }
      bad = 1; return
    }
  }
  if (t == "[") {
    if (emit && path != "") out(path, "a", "")
    ti++
    if (T[ti] == "]") { ti++; return }
    for (;;) {
      parse("", depth + 1, 0)
      if (bad) return
      if (T[ti] == ",") { ti++; continue }
      if (T[ti] == "]") { ti++; return }
      bad = 1; return
    }
  }
  if (t == "s") {
    k = decode(P[V[ti]])
    if (!bad && emit) out(path, ctl ? "c" : "s", k)
    ti++; return
  }
  if (t == "n") { if (emit) out(path, "n", V[ti]); ti++; return }
  if (t == "l") { if (emit) out(path, V[ti] == "true" ? "t" : V[ti] == "false" ? "f" : "z", ""); ti++; return }
  bad = 1
}
function raw(i) {
  if (T[i] == "s") return "\"" rep(rep(P[V[i]], BS, "\\\\"), QT, "\\\"") "\""
  if (T[i] == "n" || T[i] == "l") return V[i]
  return T[i]
}
function row(   n, i, ks, k, t, v, line) {
  n = split(keys, ks, " ")
  line = top
  for (i = 1; i <= n; i++) {
    t = substr(ks[i], length(ks[i])); k = substr(ks[i], 1, length(ks[i]) - 2); v = ""
    if (t == "s" && (RK[k] == "s" || RK[k] == "c")) v = RV[k]
    else if (t == "n" && (RK[k] == "n" || RK[k] == "s")) v = RV[k]
    else if (t == "n" && RK[k] == "t") v = 1
    line = line "\t" v
  }
  print line
  split("", RK); split("", RV)
}
BEGIN { BS = sprintf("%c", 1); QT = sprintf("%c", 2); DEL = sprintf("%c", 127) }
{ text = text $0 "\n" }
END {
  for (i = 1; i < 32; i++) if (i != 9 && i != 10 && i != 13 && index(text, sprintf("%c", i))) bad = 1
  gsub(/\\\\/, BS, text); gsub(/\\"/, QT, text)
  m = split(text, P, "\"")
  if (m > 0 && m % 2 == 0) bad = 1
  nt = 0; word = ""
  for (i = 1; i <= m && !bad; i++) {
    if (i % 2 == 0) { T[++nt] = "s"; V[nt] = i; continue }
    p = P[i]; L = length(p)
    for (j = 1; j <= L; j++) {
      c = substr(p, j, 1)
      if (c == " " || c == "\t" || c == "\n" || c == "\r") { if (word != "") lit(); continue }
      if (c == "{" || c == "}" || c == "[" || c == "]" || c == ":" || c == ",") { if (word != "") lit(); T[++nt] = c; continue }
      word = word c
    }
    if (word != "") lit()
  }
  ti = 1; rec = 0; nm = 0
  if (!bad) {
    if (mode == "rows") {
      while (ti <= nt && !bad) {
        rec++; top = T[ti] == "{" ? "o" : T[ti] == "[" ? "a" : "x"
        parse("", 0, 1)
        if (!bad) { if (top == "x") bad = 1; else row() }
      }
    } else {
      rec = 1
      parse("", 0, mode == "fields")
      if (ti <= nt) bad = 1
    }
  }
  if (mode == "answer") {
    if (bad || nt == 0) { print "{\"status\":" status ",\"data\":null}"; exit 0 }
    has = 0
    for (q = 1; q <= nm; q++) if (MK[q] == "data") has = 1
    if (T[1] == "{" && has) {
      printf "{\"status\":%s", status
      for (q = 1; q <= nm; q++) if (MK[q] != "status") {
        printf ",%s:", raw(MT[q])
        for (i = MS[q]; i <= ME[q]; i++) printf "%s", raw(i)
      }
      print "}"
    } else {
      printf "{\"status\":%s,\"data\":", status
      for (i = 1; i <= nt; i++) printf "%s", raw(i)
      print "}"
    }
    exit 0
  }
  if (bad) exit 1
  if (mode == "compact") { for (i = 1; i <= nt; i++) printf "%s", raw(i); print "" }
  exit 0
}'

# Dates, the left record (rows: origin TAB keyName TAB expiresAt TAB reason TAB at), key names and curl settings.
# shellcheck disable=SC2016 # awk's own fields
UTIL_AWK='
function rep(s, from, to,   r, k) {
  r = ""
  while ((k = index(s, from)) > 0) { r = r substr(s, 1, k - 1) to; s = substr(s, k + length(from)) }
  return r s
}
function jesc(s) { return rep(rep(s, "\\", "\\\\"), "\"", "\\\"") }
function plain(s,   i) {
  if (index(s, "\"") || index(s, "\\")) return 0
  for (i = 1; i < 32; i++) if (index(s, sprintf("%c", i))) return 0
  return !index(s, sprintf("%c", 127))
}
function days(y, m, d,   era, yoe, doy, doe) {
  y -= (m <= 2)
  era = int((y >= 0 ? y : y - 399) / 400)
  yoe = y - era * 400
  doy = int((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return era * 146097 + doe - 719468
}
function ms(s,   y, mo, d, h, mi, se, f, z, t, off) {
  if (s ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) s = s "T00:00:00Z"
  if (s !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9](:[0-9][0-9](\.[0-9]+)?)?(Z|[+-][0-9][0-9]:[0-9][0-9])$/) return -1
  y = substr(s, 1, 4) + 0; mo = substr(s, 6, 2) + 0; d = substr(s, 9, 2) + 0
  h = substr(s, 12, 2) + 0; mi = substr(s, 15, 2) + 0; se = 0; f = 0
  t = substr(s, 17)
  if (substr(t, 1, 1) == ":") {
    se = substr(t, 2, 2) + 0; t = substr(t, 4)
    if (substr(t, 1, 1) == ".") { t = substr(t, 2); z = t; sub(/[^0-9].*$/, "", z); t = substr(t, length(z) + 1); f = substr(z "00", 1, 3) + 0 }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || se > 59) return -1
  off = 0
  if (t != "Z") { off = (substr(t, 2, 2) * 60 + substr(t, 5, 2)) * 60; if (substr(t, 1, 1) == "+") off = -off }
  return (days(y, mo, d) * 86400 + h * 3600 + mi * 60 + se + off) * 1000 + f
}
function iso(t,   s, z, era, doe, yoe, y, doy, mp, d, m) {
  s = t % 86400; z = (t - s) / 86400 + 719468
  era = int(z / 146097); doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400; doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153); d = doy - int((153 * mp + 2) / 5) + 1
  m = mp < 10 ? mp + 3 : mp - 9
  if (m <= 2) y++
  return sprintf("%04d-%02d-%02dT%02d:%02d:%02d.000Z", y, m, d, int(s / 3600), int(s % 3600 / 60), s % 60)
}
function dated(r) { return r == "replaced" || r == "disconnected" || r == "not_saved" }
function known(r) { return dated(r) || r == "key_unknown" || r == "session_unknown" }
function live(x, r) { return !dated(r) || x == "" || ms(x) > now * 1000 }
# An entry for the key of the current connection (o, k): a run stopped between recording it and changing the connection.
function stale() { return o != "" && ($4 == "replaced" || $4 == "disconnected") && $1 == o && $2 == k }
function message(o, k, x, r) {
  if (r == "session_unknown") return "On " o ": " st
  if (r == "key_unknown") return "On " o ": a key named \"" k "\" may exist; delete it in Settings, Agent access."
  return "On " o ": the key \"" k "\" " (r == "replaced" ? "was replaced" : r == "disconnected" ? "was disconnected" : "could not be saved") " but still works until " (x == "" ? "it ends" : x) "; delete it in Settings, Agent access, if nothing uses it."
}
BEGIN {
  FS = "\t"; SENT = sprintf("%c", 1)
  if (mode == "iso") { print iso(t); exit }
  if (mode == "ms") { printf "%.0f\n", ms(s); exit }
}
mode == "left-read" { if (known($5)) print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6; next }
mode == "left-add" {
  if ($0 == "--") { sect = 1; next }
  if ($0 == "") next
  if (!sect) { if (live($3, $4)) { n++; O[n] = $1; K[n] = $2; X[n] = $3; R[n] = $4; A[n] = $5 }; next }
  dup = 0
  for (i = 1; i <= n; i++) if (O[i] == $1 && K[i] == $2 && (R[i] == $4 || ($4 == "key_unknown" && dated(R[i])))) dup = 1
  if (dup) next
  if (dated($4)) {
    w = 0
    for (i = 1; i <= n; i++) if (!(O[i] == $1 && K[i] == $2 && R[i] == "key_unknown")) { w++; O[w] = O[i]; K[w] = K[i]; X[w] = X[i]; R[w] = R[i]; A[w] = A[i] }
    n = w
  }
  n++; O[n] = $1; K[n] = $2; X[n] = $3; R[n] = $4; A[n] = at
  next
}
mode == "left-drop" { if ($0 != "" && !stale()) print; next }
mode == "left-write" {
  if ($0 == "") next
  split("origin keyName expiresAt reason at", names, " ")
  for (i = 1; i <= 5; i++) if (!plain($i)) { badname = names[i]; bad = 3; exit 3 }
  buf = buf sprintf("{\"origin\":\"%s\",\"keyName\":\"%s\",\"expiresAt\":\"%s\",\"reason\":\"%s\",\"at\":\"%s\"}\n", $1, $2, $3, $4, $5)
  next
}
mode == "left-public" {
  if ($0 == "" || !live($3, $4) || stale()) next
  list = list (list == "" ? "" : ",") "{\"origin\":\"" jesc($1) "\",\"keyName\":\"" jesc($2) "\",\"expiresAt\":\"" jesc($3) "\",\"reason\":\"" jesc($4) "\",\"at\":\"" jesc($5) "\",\"message\":\"" jesc(message($1, $2, $3, $4)) "\"}"
  next
}
mode == "keyname" { name = (NR > 1 ? name "\n" : "") $0; next }
mode == "cfg" {
  s = $0
  if (substr(s, length(s)) == SENT) s = substr(s, 1, length(s) - 1)
  s = rep(rep(rep(s, "\\", "\\\\"), "\"", "\\\""), "\r", "\\r")
  printf "%s%s", (NR > 1 ? "\\n" : ""), s
  next
}
END {
  if (mode == "left-add") for (i = 1; i <= n; i++) print O[i] "\t" K[i] "\t" X[i] "\t" R[i] "\t" A[i]
  if (mode == "left-public") print "[" list "]"
  if (mode == "left-write") printf "%s", (bad ? badname : buf)
  if (mode == "keyname") {
    gsub(/[^A-Za-z0-9._-]+/, "-", name); name = substr(name, 1, 15); gsub(/^-+/, "", name); gsub(/-+$/, "", name)
    print (name == "" ? "agent" : name)
  }
  exit bad
}'

json() {
  json_mode=$1
  shift
  LC_ALL=C awk -v mode="$json_mode" "$@" "$JSON_AWK"
}
util() {
  util_mode=$1
  shift
  LC_ALL=C awk -v mode="$util_mode" "$@" "$UTIL_AWK"
}

LOCKTOKEN=""
TMPFILE=""
SECURED=0
E_CODE="" E_MSG="" E_STATUS="" E_BODY="" E_SENT=yes

now() { echo $(($(date +%s) + CLOCK_OFFSET)); }
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
lower() { printf '%s' "$1" | tr "$UPPER" "$LOWER"; }
nap() { sleep "$1" 2>/dev/null || sleep 1; }
iso() { util iso -v t="$1" </dev/null; }

# A message or a value inside a JSON string.
esc() {
  case $1 in
    *[\\\"$CTL]*) printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' ;;
    *) printf '%s' "$1" ;;
  esac
}

cleanup() {
  [ -z "$LOCKTOKEN" ] || release
  [ -z "$TMPFILE" ] || rm -f -- "$TMPFILE"
  return 0
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# raise CODE MESSAGE [STATUS [BODY]]: records the failure; the caller returns 1, and so on up to the command.
raise() {
  E_CODE=$1 E_MSG=$2 E_STATUS=${3:-} E_BODY=${4:-} E_SENT=yes
  return 1
}
insecure() { raise insecure_credentials "$1"; }
# err_save SLOT / err_restore SLOT: keep a failure while other steps run.
err_save() { eval "${1}_code=\$E_CODE ${1}_msg=\$E_MSG ${1}_status=\$E_STATUS ${1}_body=\$E_BODY ${1}_sent=\$E_SENT"; }
err_restore() { eval "E_CODE=\$${1}_code E_MSG=\$${1}_msg E_STATUS=\$${1}_status E_BODY=\$${1}_body E_SENT=\$${1}_sent"; }

secret_ok() {
  case $1 in "" | *[!$UPPER$LOWER$DIGIT._~+/=-]*) return 1 ;; esac
  [ ${#1} -ge 8 ] && [ ${#1} -le 512 ]
}
plain_ok() {
  case $1 in *[\\\"$CTL]*) return 1 ;; esac
  return 0
}

# num VALUE: _n, a stored number as mikud.mjs keeps it (a whole number, 0 when it is none or below 0).
num() {
  _n=$1
  case $_n in *.*) _n=${_n%%.*} ;; esac
  case $_n in "" | *[!$DIGIT]*) _n=0 ;; esac
  while :; do
    case $_n in 0?*) _n=${_n#0} ;; *) break ;; esac
  done
  [ ${#_n} -le 15 ] || _n=0
}

# int_of VALUE FALLBACK: INT, Math.max(1, Math.floor(Number(VALUE) || FALLBACK)) for a JSON number or string.
int_of() {
  INT=$2
  case $1 in "" | - | *[!$DIGIT.-]* | *.*.* | ?*-* | *-.* | *.) return 0 ;; esac
  io_abs=${1#-}
  io_int=${io_abs%%.*}
  case $io_abs$io_int in *[123456789]*) ;; *) return 0 ;; esac
  case $1 in -*)
    INT=1
    return 0
    ;;
  esac
  num "${io_int:-0}"
  INT=$_n
  [ "$INT" -ge 1 ] || INT=1
}

# Answers: BODY is read into JF (the "fields" lines); jget PATH sets JK and JV, jstr PATH keeps strings only (a
# string that held a control character gets one back, so no check takes it for a plain value).
parse_answer() {
  if JF=$(printf '%s' "$BODY" | json fields); then JSON_OK=1; else
    JSON_OK=0
    JF=""
  fi
}
jget() {
  JK="" JV=""
  jg_rest=$JF
  while [ -n "$jg_rest" ]; do
    jg_line=${jg_rest%%"$NL"*}
    if [ "$jg_line" = "$jg_rest" ]; then jg_rest=""; else jg_rest=${jg_rest#*"$NL"}; fi
    jg_line=${jg_line#1"$TAB"}
    case $jg_line in
      "$1$TAB"*)
        jg_line=${jg_line#"$1$TAB"}
        JK=${jg_line%%"$TAB"*}
        JV=${jg_line#*"$TAB"}
        return 0
        ;;
    esac
  done
  return 1
}
jnum() {
  jget "$1"
  case $JK in n | s) ;; *) JV="" ;; esac
}
jstr() {
  jget "$1"
  case $JK in
    s) ;;
    c) JV="$JV$(printf '\001')" ;;
    *) JV="" ;;
  esac
}

if [ $# -gt 0 ]; then
  COMMAND=$1
  shift
else COMMAND=help; fi
case $COMMAND in
  help | --help | -h)
    printf '%s\n' "$HELP"
    exit 0
    ;;
esac

# Arguments
OPT_URL="" OPT_DAYS="" OPT_DAYS_SET=0 OPT_JSON="" OPT_JSON_SET=0 OPT_JSONFILE="" OPT_JSONFILE_SET=0
OPT_AS="" OPT_AS_SET=0 OPT_REPLACE=0 OPT_WAIT=0 OPT_CLEAR=0 POS_COUNT=0 POS1=""

print_error() {
  [ -n "$E_CODE" ] || E_CODE=failed E_MSG=${E_MSG:-The command failed.}
  pe_out="{\"error\":\"$(esc "$E_CODE")\",\"message\":\"$(esc "$E_MSG")\""
  [ -z "$E_STATUS" ] || pe_out="$pe_out,\"status\":$E_STATUS"
  [ -z "$E_BODY" ] || pe_out="$pe_out,\"body\":$E_BODY"
  if [ "${1:-0}" = 1 ]; then
    pe_left=$(left_now)
    [ "$pe_left" = "[]" ] || pe_out="$pe_out,\"left\":$pe_left"
  fi
  printf '%s}\n' "$pe_out"
}

parse_args() {
  while [ $# -gt 0 ]; do
    pa=$1
    shift
    case $pa in
      --url | --days | --json | --json-file | --as)
        if [ $# -eq 0 ]; then
          raise bad_option "$pa needs a value."
          return
        fi
        case $pa in
          --url) OPT_URL=$1 ;;
          --days) OPT_DAYS=$1 OPT_DAYS_SET=1 ;;
          --json) OPT_JSON=$1 OPT_JSON_SET=1 ;;
          --json-file) OPT_JSONFILE=$1 OPT_JSONFILE_SET=1 ;;
          --as) OPT_AS=$1 OPT_AS_SET=1 ;;
        esac
        shift
        ;;
      --replace) OPT_REPLACE=1 ;;
      --wait) OPT_WAIT=1 ;;
      --clear-left) OPT_CLEAR=1 ;;
      --*)
        raise bad_option "Unknown option $pa. Run: mikud help"
        return
        ;;
      *)
        POS_COUNT=$((POS_COUNT + 1))
        [ "$POS_COUNT" != 1 ] || POS1=$pa
        ;;
    esac
  done
}

if ! parse_args "$@"; then
  print_error 0
  exit 1
fi

MYUID=$(id -u)
OS=$(uname -s)
HOST=$(uname -n)
HOST_LOWER=$(lower "$HOST")

# Where the connection is kept: one folder per computer user, shared by every agent install of that user.
DIR=${MIKUD_SKILL_HOME:-}
[ -n "$DIR" ] || DIR="${HOME:-}/.mikud"
case $DIR in /*) ;; *) DIR="$PWD/$DIR" ;; esac
while :; do
  case $DIR in ?*/) DIR=${DIR%/} ;; *) break ;; esac
done
CONNECTION="$DIR/connection"
PENDING="$DIR/pending"
LEFT_FILE="$DIR/left"
LOCK="$DIR/lock"
BREAKER="$DIR/lock.break"

# Addresses

# url_parse RAW: UP (ok or bad), UP_scheme, UP_host, UP_origin and UP_extra (1 when it holds more than the origin).
url_parse() {
  UP=bad UP_scheme="" UP_host="" UP_origin="" UP_extra=0
  up_s=${1%%:*}
  [ "$up_s" != "$1" ] || return 0
  case $up_s in "" | [!$UPPER$LOWER]* | *[!$UPPER$LOWER$DIGIT+.-]*) return 0 ;; esac
  UP_scheme=$(lower "$up_s")
  up_r=${1#*:}
  case $UP_scheme in
    http | https) ;;
    *)
      UP=ok UP_extra=1
      return 0
      ;;
  esac
  case $up_r in //*) up_r=${up_r#//} ;; *) return 0 ;; esac
  up_auth=${up_r%%[/?#]*}
  up_tail=${up_r#"$up_auth"}
  case $up_auth in *@*)
    UP_extra=1
    up_auth=${up_auth##*@}
    ;;
  esac
  case $up_auth in
    \[*\]:* | \[*\])
      up_host=${up_auth%%\]*}\]
      up_port=${up_auth#"$up_host"}
      case $up_host in "[]" | \[*[!${DIGIT}abcdefABCDEF:.]*\]) return 0 ;; esac
      ;;
    *)
      up_host=${up_auth%%:*}
      up_port=${up_auth#"$up_host"}
      case $up_host in "" | *[!$UPPER$LOWER$DIGIT._-]*) return 0 ;; esac
      ;;
  esac
  up_port=${up_port#:}
  case $up_port in *[!$DIGIT]*) return 0 ;; esac
  if [ -n "$up_port" ]; then
    num "$up_port"
    [ "$_n" -le 65535 ] || return 0
    up_port=$_n
  fi
  UP_host=$(lower "$up_host")
  [ "$UP_scheme:$up_port" != https:443 ] || up_port=""
  [ "$UP_scheme:$up_port" != http:80 ] || up_port=""
  UP_origin="$UP_scheme://$UP_host${up_port:+:$up_port}"
  case ${up_tail#/} in "" | "?" | "#" | "?#") ;; *) UP_extra=1 ;; esac
  UP=ok
}

# origin_of RAW: ORIGIN, the canonical origin of an address: https, or http on this computer only; no path, query or
# credentials.
origin_of() {
  url_parse "$1"
  if [ "$UP" = bad ]; then
    raise no_url "That is not an address. Ask the owner for Mikud's address, for example https://mikud.example.com."
    return
  fi
  if [ "$UP_scheme" != https ] && ! { [ "$UP_scheme" = http ] && { [ "$UP_host" = localhost ] || [ "$UP_host" = 127.0.0.1 ]; }; }; then
    raise no_url "Mikud's address must start with https:// (http only for localhost or 127.0.0.1)."
    return
  fi
  if [ "$UP_extra" = 1 ]; then
    raise no_url "Give Mikud's address alone, for example https://mikud.example.com."
    return
  fi
  ORIGIN=$UP_origin
}

# Files: one line of JSON each (`left`: one per entry), written in one step through a private temporary file.

# stat_of PATH: ST_MODE (as ls shows it) and ST_UID.
stat_of() {
  so_ls=$(ls -ldn -- "$1" 2>/dev/null) || return 1
  # shellcheck disable=SC2086 # the fields of ls -ldn, without globbing (set -f)
  set -- $so_ls
  ST_MODE=$1 ST_UID=$3
}

# secure_home CREATE: HOME_FOUND 1 when the folder exists: a plain folder of this user that only this user can open.
secure_home() {
  HOME_FOUND=0
  if [ "$SECURED" = 1 ]; then
    HOME_FOUND=1
    return 0
  fi
  if [ ! -e "$DIR" ] && [ ! -L "$DIR" ]; then
    [ "$1" = 1 ] || return 0
    if ! mkdir -p -- "$DIR" 2>/dev/null; then
      raise cannot_save "Cannot create $DIR. Allow this agent to write there."
      return
    fi
  fi
  if [ -L "$DIR" ] || [ ! -d "$DIR" ]; then
    insecure "$DIR must be a plain folder, not a link."
    return
  fi
  if ! stat_of "$DIR"; then
    raise cannot_save "Cannot read $DIR. Allow this agent to use it."
    return
  fi
  if [ "$ST_UID" != "$MYUID" ]; then
    insecure "$DIR belongs to another user. Remove it, or set MIKUD_SKILL_HOME to a folder of your own."
    return
  fi
  case $ST_MODE in
    drwx------ | drwx------[.@+]) ;;
    *)
      insecure "Others can open $DIR. Run: chmod 700 '$DIR'"
      return
      ;;
  esac
  SECURED=1 HOME_FOUND=1
}

private_file() {
  case $ST_MODE in -rw------- | -rw-------[.@+]) return 0 ;; esac
  return 1
}

# check_file FILE: CF_FOUND 1 when it exists, a plain file of this user that only this user can read.
check_file() {
  CF_FOUND=0
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi
  if [ -L "$1" ] || [ ! -f "$1" ]; then
    insecure "$1 must be a plain file, not a link."
    return
  fi
  stat_of "$1" || return 0
  if [ "$ST_UID" != "$MYUID" ]; then
    insecure "$1 belongs to another user. Remove it and connect again."
    return
  fi
  if ! private_file; then
    insecure "Others can read $1. Run: chmod 600 '$1'"
    return
  fi
  CF_FOUND=1
}

# read_private FILE: RP_FOUND and RP_TEXT.
read_private() {
  RP_FOUND=0 RP_TEXT=""
  secure_home 0 || return
  [ "$HOME_FOUND" = 1 ] || return 0
  check_file "$1" || return
  [ "$CF_FOUND" = 1 ] || return 0
  if ! RP_TEXT=$(cat -- "$1" 2>/dev/null && printf x); then
    RP_TEXT=""
    [ -e "$1" ] || return 0
    raise cannot_save "Cannot read $1. Allow this agent to use $DIR."
    return
  fi
  RP_TEXT=${RP_TEXT%x}
  RP_FOUND=1
}

hook() {
  eval "hk_at=\${MIKUD_TEST_HOLD_$1:-}"
  [ -n "$hk_at" ] || return 0
  printf '%s' "$$" >"$hk_at.reached"
  hk_i=0
  while [ $hk_i -lt 1200 ] && [ ! -e "$hk_at.go" ]; do
    nap 0.05
    hk_i=$((hk_i + 1))
  done
}

# rename_over FROM TO: moves the temporary file over the target in one step.
rename_over() {
  if [ -d "$2" ] || ! mv -f -- "$1" "$2" 2>/dev/null; then
    rm -f -- "$1"
    TMPFILE=""
    raise cannot_save "Cannot replace $2. Allow this agent to write in its folder."
    return
  fi
  TMPFILE=""
}

# write_private FILE TEXT: a temporary file made private before anything is written, then renamed over. Only by the
# holder of the lock. A temporary file a stopped command left behind is removed by the next holder (sweep).
write_private() {
  assert_mine || return
  secure_home 1 || return
  TMPFILE="$1.$(rand 6).tmp"
  if ! (
    set -C
    : >"$TMPFILE"
  ) 2>/dev/null; then
    TMPFILE=""
    raise cannot_save "Cannot write in $DIR. Allow this agent to write there."
    return
  fi
  if ! stat_of "$TMPFILE" || [ "$ST_UID" != "$MYUID" ] || ! private_file; then
    insecure "Could not make $TMPFILE private before writing it."
    rm -f -- "$TMPFILE"
    TMPFILE=""
    return 1
  fi
  hook TEMP
  if ! printf '%s' "$2" >>"$TMPFILE" 2>/dev/null; then
    rm -f -- "$TMPFILE"
    TMPFILE=""
    raise cannot_save "Cannot write in $DIR. Allow this agent to write there."
    return
  fi
  hook WRITTEN
  rename_over "$TMPFILE" "$1"
}

remove_file() {
  assert_mine || return
  if ! rm -f -- "$1" 2>/dev/null; then
    raise cannot_save "Cannot remove $1. Allow this agent to write in $DIR."
    return
  fi
}

# rec_clear PREFIX FIELDS / rec_copy FROM TO FIELDS / row_vars PREFIX FIELDS ROW
rec_clear() {
  for rcl_f in $2; do
    case $rcl_f in *:n) eval "$1${rcl_f%:*}=0" ;; *) eval "$1${rcl_f%:*}=''" ;; esac
  done
}
rec_copy() {
  for rcp_f in $3; do eval "$2${rcp_f%:*}=\$$1${rcp_f%:*}"; done
}
row_vars() {
  rv_rest=${3#*"$TAB"}
  for rv_f in $2; do
    case $rv_rest in
      *"$TAB"*) rv_v=${rv_rest%%"$TAB"*} rv_rest=${rv_rest#*"$TAB"} ;;
      *) rv_v=$rv_rest rv_rest="" ;;
    esac
    case $rv_f in *:n)
      num "$rv_v"
      rv_v=$_n
      ;;
    esac
    eval "$1${rv_f%:*}=\$rv_v"
  done
}

# serialize FIELDS PREFIX: SER, the record as one line of JSON in the order every version writes it.
serialize() {
  SER="" sz_sep=""
  for sz_f in $1; do
    sz_k=${sz_f%:*}
    eval "sz_v=\${$2$sz_k}"
    case $sz_f in
      *:n)
        num "$sz_v"
        SER="$SER$sz_sep\"$sz_k\":$_n"
        ;;
      *)
        if ! plain_ok "$sz_v"; then
          raise unexpected_answer "Mikud sent a value that cannot be stored ($sz_k)."
          return
        fi
        SER="$SER$sz_sep\"$sz_k\":\"$sz_v\""
        ;;
    esac
    sz_sep=,
  done
  SER="{$SER}"
}

# read_record FILE FIELDS PREFIX: PREFIX<field> for each field, and PREFIXfound.
read_record() {
  eval "${3}found=0"
  rec_clear "$3" "$2"
  read_private "$1" || return
  [ "$RP_FOUND" = 1 ] || return 0
  if ! rr_row=$(printf '%s' "$RP_TEXT" | json rows -v keys="$2") || [ -z "$rr_row" ]; then
    insecure "$1 is damaged. Delete it and connect again."
    return
  fi
  case $rr_row in *"$NL"*)
    insecure "$1 is damaged. Delete it and connect again."
    return
    ;;
  esac
  row_vars "$3" "$2" "$rr_row"
  eval "${3}found=1"
}

read_connection() {
  read_record "$CONNECTION" "$CONN_FIELDS" "$1" || return
  eval "rc_found=\$${1}found rc_o=\$${1}origin rc_k=\$${1}key rc_n=\$${1}keyName"
  if [ "$rc_found" = 1 ] && { [ -z "$rc_o" ] || [ -z "$rc_k" ] || [ -z "$rc_n" ]; }; then
    insecure "$CONNECTION is damaged. Delete it and connect again."
    return
  fi
}

read_pending() {
  read_record "$PENDING" "$PEND_FIELDS" "$1" || return
  eval "rp_found=\$${1}found rp_i=\$${1}attemptId rp_o=\$${1}origin rp_d=\$${1}deviceCode rp_p=\$${1}phase"
  [ "$rp_found" = 1 ] || return 0
  case $rp_p in polling | creating_key) ;; *) rp_i="" ;; esac
  if [ -z "$rp_i" ] || [ -z "$rp_o" ] || [ -z "$rp_d" ]; then
    insecure "$PENDING is damaged. Delete it and connect again."
    return
  fi
}

write_connection() {
  serialize "$CONN_FIELDS" "$1" || return
  write_private "$CONNECTION" "$SER$NL"
}

# rec_same A B FIELDS: the records A and B (Afound, Bfound and each field) are the same, or both absent.
rec_same() {
  eval "rs_a=\${${1}found:-0} rs_b=\${${2}found:-0}"
  [ "$rs_a" = "$rs_b" ] || return 1
  [ "$rs_a" = 1 ] || return 0
  for rs_f in $3; do
    eval "[ \"\${$1${rs_f%:*}}\" = \"\${$2${rs_f%:*}}\" ]" || return 1
  done
}

# save_pending PREFIX SEEN: writes the attempt PREFIX only while the file is exactly as this command last read or
# wrote it (SEEN; SEENfound=0: no attempt), and SEEN is then what was written. Raises "changed" otherwise (the caller
# answers from the new state).
save_pending() {
  read_pending X_ || return
  if ! rec_same X_ "$2" "$PEND_FIELDS"; then
    raise changed "The attempt changed."
    return
  fi
  serialize "$PEND_FIELDS" "$1" || return
  write_private "$PENDING" "$SER$NL" || return
  rec_copy "$1" "$2" "$PEND_FIELDS"
  eval "${2}found=1"
}

# The left record: what the command left on Mikud, with non-secret fields only. LEFT holds its rows.

read_left() {
  LEFT=""
  read_private "$LEFT_FILE" || return
  [ "$RP_FOUND" = 1 ] || return 0
  if ! rl_rows=$(printf '%s' "$RP_TEXT" | json rows -v keys="$LEFT_FIELDS"); then
    insecure "$LEFT_FILE is damaged. Delete it and connect again."
    return
  fi
  LEFT=$(printf '%s\n' "$rl_rows" | util left-read)
}

write_left() {
  if [ -z "$1" ]; then
    remove_file "$LEFT_FILE"
    return
  fi
  if ! wl_text=$(printf '%s\n' "$1" | util left-write); then
    raise unexpected_answer "Mikud sent a value that cannot be stored ($wl_text)."
    return
  fi
  write_private "$LEFT_FILE" "$wl_text$NL"
}

# add_left ROWS (origin TAB keyName TAB expiresAt TAB reason): adds entries under the lock, before the change that
# would lose what they record.
add_left() {
  read_left || return
  al_now=$(now)
  al_rows=$(printf '%s\n--\n%s\n' "$LEFT" "$1" | util left-add -v now="$al_now" -v at="$(iso "$al_now")")
  write_left "$al_rows"
}

# left_public ROWS [ORIGIN KEYNAME]: the entries to report; never one for the key of the connection ORIGIN KEYNAME.
left_public() { printf '%s\n' "$1" | util left-public -v now="$(now)" -v st="$SESSION_TEXT" -v o="${2:-}" -v k="${3:-}"; }

# prune_left: an entry for the key of the current connection (C_) is a run stopped after recording that key as
# replaced or disconnected and before changing the connection: removed, under the lock.
prune_left() {
  [ "$C_found" = 1 ] || return 0
  read_left || return
  pl_rows=$(printf '%s\n' "$LEFT" | util left-drop -v o="$C_origin" -v k="$C_keyName")
  [ "$pl_rows" = "$LEFT" ] || write_left "$pl_rows"
}

# What the command left on Mikud, for an answer; [] when it cannot be read. Runs in a subshell: $(left_now).
left_now() {
  if read_left; then
    if ! read_connection LN_ || [ "$LN_found" != 1 ]; then LN_origin="" LN_keyName=""; fi
    LN_key=""
    left_public "$LEFT" "$LN_origin" "$LN_keyName"
  else printf '[]'; fi
}

# The lock: a file created exclusively, naming its holder (token, host, process id and that process's start time).
# Taken from a holder only when it is certainly gone, under lock.break (break_lock), and released by its token only.

# start_of PID: START, the start time of a process as the system reports it, the same in every version; "" when it
# cannot be read.
start_of() {
  START=""
  if [ "$OS" = Linux ]; then
    so_stat=""
    IFS= read -r so_stat 2>/dev/null <"/proc/$1/stat" || [ -n "$so_stat" ] || return 0
    # Field 22; the fields after the command name, which may hold spaces, start with field 3.
    so_stat=${so_stat##*\)}
    # shellcheck disable=SC2086 # split into fields, without globbing (set -f)
    set -- $so_stat
    [ $# -lt 20 ] || START=${20}
    return 0
  fi
  START=$(ps -o lstart= -p "$1" 2>/dev/null) || START=""
  START=${START#"${START%%[! ]*}"}
  START=${START%"${START##*[! ]}"}
}

running() {
  kill -0 "$1" 2>/dev/null && return 0
  if [ "$OS" = Linux ]; then
    [ -d "/proc/$1" ]
  else
    ps -p "$1" >/dev/null 2>&1
  fi
}

# read_owner FILE: OW_STATE free, unreadable or held (with OW_token, OW_host, OW_pid and OW_start).
read_owner() {
  OW_STATE=free
  rec_clear OW_ "$OWNER_FIELDS"
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi
  if [ -L "$1" ]; then
    insecure "$1 must be a plain file, not a link."
    return
  fi
  OW_STATE=unreadable
  if ! ro_text=$(cat -- "$1" 2>/dev/null); then
    if [ ! -e "$1" ] && [ ! -L "$1" ]; then OW_STATE=free; fi
    return 0
  fi
  ro_row=$(printf '%s' "$ro_text" | json rows -v keys="$OWNER_FIELDS") || return 0
  case $ro_row in "" | *"$NL"*) return 0 ;; esac
  row_vars OW_ "$OWNER_FIELDS" "$ro_row"
  # A pid that is not a whole number is undecidable.
  ro_pid=${ro_row#*"$TAB"}
  ro_pid=${ro_pid#*"$TAB"}
  ro_pid=${ro_pid#*"$TAB"}
  case ${ro_pid%%"$TAB"*} in "" | *[!$DIGIT]*) OW_pid=0 ;; esac
  [ -z "$OW_token" ] || OW_STATE=held
}

# verdict: VERDICT free, alive, gone (certainly: same host, and the process ended or its id now runs another start),
# or unknown.
verdict() {
  case $OW_STATE in
    free)
      VERDICT=free
      return 0
      ;;
    unreadable)
      VERDICT=unknown
      return 0
      ;;
  esac
  VERDICT=unknown
  [ "$(lower "$OW_host")" = "$HOST_LOWER" ] || return 0
  [ "$OW_pid" != 0 ] || return 0
  if ! running "$OW_pid"; then
    VERDICT=gone
    return 0
  fi
  [ -n "$OW_start" ] || return 0
  start_of "$OW_pid"
  [ -n "$START" ] || return 0
  if [ "$START" = "$OW_start" ]; then VERDICT=alive; else VERDICT=gone; fi
}

# mine: the lock is this command's (it names this command's token).
mine() {
  [ -n "$LOCKTOKEN" ] || return 1
  mn_line=""
  IFS= read -r mn_line 2>/dev/null <"$LOCK" || [ -n "$mn_line" ] || return 1
  case $mn_line in "{\"token\":\"$LOCKTOKEN\","*) return 0 ;; esac
  return 1
}

acquire() {
  secure_home 1 || return
  aq_token=$(rand 16)
  start_of $$
  aq_owner="{\"token\":\"$aq_token\",\"host\":\"$(esc "$HOST")\",\"pid\":$$,\"start\":\"$(esc "$START")\"}"
  aq_deadline=$(($(date +%s) + (LOCK_WAIT_MS + 999) / 1000))
  while :; do
    # noclobber: created only when no file has the name (O_EXCL).
    if (
      set -C
      printf '%s\n' "$aq_owner" >"$LOCK"
    ) 2>/dev/null; then
      LOCKTOKEN=$aq_token
      hook LOCKED
      sweep || return
      return 0
    fi
    if [ ! -e "$LOCK" ] && [ ! -L "$LOCK" ] && [ ! -w "$DIR" ]; then
      raise cannot_save "Cannot create a lock in $DIR. Allow this agent to write there."
      return
    fi
    read_owner "$LOCK" || return
    verdict
    if [ "$(date +%s)" -gt "$aq_deadline" ]; then
      lock_busy
      return
    fi
    if [ "$VERDICT" = gone ]; then
      hook BREAK_OBSERVED
      break_lock "$OW_token"
      case $? in
        0) continue ;;
        2) return 1 ;;
      esac
    fi
    if [ "$VERDICT" = free ]; then
      nap 0.05
    else
      aq_r=$(od -An -N1 -tu1 /dev/urandom | tr -d ' \n')
      nap "0.$(printf '%03d' $((100 + ${aq_r:-100} * 200 / 255)))"
    fi
  done
}

# lock_busy: the answer once the wait for the lock ended; VERDICT is the verdict on the lock as last read.
lock_busy() {
  lb_hand="Nothing was sent. If no mikud command runs on this computer, remove that file by hand and run the command again."
  if [ -e "$BREAKER" ] || [ -L "$BREAKER" ]; then
    raise busy "Another mikud command may be removing a lock, or it stopped while doing so and left $BREAKER. $lb_hand"
  elif [ "$VERDICT" = unknown ]; then
    raise busy "Another mikud command may hold the lock $LOCK, and this command cannot tell whether it still runs. $lb_hand"
  elif [ "$VERDICT" = gone ]; then
    raise busy "The lock $LOCK was left by a mikud command that has ended, and this command cannot remove it. $lb_hand"
  else
    raise busy "Another mikud command is using the connection. Nothing was sent; run it again."
  fi
}

# break_lock TOKEN: removes the lock of the holder TOKEN names, which is certainly gone. Only the holder of lock.break
# (created exclusively, naming its holder) removes a lock it does not hold, and only while that lock still names the
# same dead holder: a lock taken meanwhile is never touched. 0 when the lock is gone or now names another holder (try
# again at once); 1 when another command is breaking it or it could not be removed; 2 on a failure (raised). Nobody
# else ever removes a lock.break: one left behind is named in busy for the owner to remove by hand.
break_lock() {
  bl_token=$1
  if ! (
    set -C
    printf '%s\n' "$aq_owner" >"$BREAKER"
  ) 2>/dev/null; then
    return 1
  fi
  hook BREAK_HELD
  bl_rc=0
  if ! read_owner "$LOCK"; then
    bl_rc=2
  elif [ "$OW_STATE" = held ] && [ "$OW_token" = "$bl_token" ]; then
    verdict
    if [ "$VERDICT" = gone ] && ! rm -f -- "$LOCK" 2>/dev/null; then bl_rc=1; fi
  fi
  rm -f -- "$BREAKER" 2>/dev/null || :
  return $bl_rc
}

release() {
  if mine; then rm -f -- "$LOCK" 2>/dev/null || :; fi
  LOCKTOKEN=""
}

# with_lock COMMAND...: runs it under the lock.
with_lock() {
  acquire || return
  "$@"
  wl_rc=$?
  release
  return $wl_rc
}

# Before a request that spends a one-time secret, and before every change to a file: the lock must be this command's.
assert_mine() {
  mine && return 0
  raise busy "Another mikud command took over the connection. Run it again."
}

# sweep: removes the temporary files of write_private that a stopped command left behind (they may hold a secret).
# Every one is written under the lock, so the holder finds only those.
sweep() {
  assert_mine || return
  set +f
  for sw_f in "$DIR"/*.tmp; do
    sw_n=${sw_f##*/}
    sw_h=${sw_n#*.}
    sw_h=${sw_h%.tmp}
    case ${sw_n%%.*} in connection | pending | left) ;; *) continue ;; esac
    case $sw_h in "" | *[!0123456789abcdef]*) continue ;; esac
    [ ${#sw_h} -eq 12 ] || continue
    rm -f -- "$sw_f"
  done
  set -f
}

# Requests

need_curl() {
  command -v curl >/dev/null 2>&1 && return 0
  raise missing_curl "curl is needed. Install curl, or Node 20 or later."
}

# request ORIGIN METHOD PATH SETTINGS: one request to the stored origin only, never following a redirect. SETTINGS are
# curl settings (headers and body, secrets too), read by curl from its standard input. Sets STATUS and BODY.
request() {
  # The subshell lets go of this command's error output at once: a stopped command leaves nothing holding it.
  rq_out=$(
    exec 2>/dev/null
    printf 'url = "%s%s"\nrequest = "%s"\nheader = "Accept: application/json"\n%s\n' "$1" "$3" "$2" "$4" |
      curl -q -s -K - --proto "=${1%%:*}" --max-redirs 0 --globoff --path-as-is --noproxy '*' \
        --max-time "$TIMEOUT_S" -w '\n%{http_code}'
  )
  rq_rc=$?
  case $rq_out in
    *"$NL"*) STATUS=${rq_out##*"$NL"} BODY=${rq_out%"$NL"*} ;;
    *) STATUS=$rq_out BODY="" ;;
  esac
  case $STATUS in [$DIGIT][$DIGIT][$DIGIT]) ;; *) [ $rq_rc -ne 0 ] || rq_rc=1 ;; esac
  if [ $rq_rc -ne 0 ]; then
    STATUS="" BODY=""
    case $rq_rc in
      6) rq_why=ENOTFOUND ;;
      7) rq_why=ECONNREFUSED ;;
      28) rq_why=TimeoutError ;;
      52 | 56) rq_why=UND_ERR_SOCKET ;;
      *) rq_why="curl error $rq_rc" ;;
    esac
    raise unreachable "Cannot reach $1 ($rq_why)."
    # Failures that happen before anything reaches the server.
    case $rq_rc in 5 | 6 | 7 | 35 | 51 | 53 | 54 | 58 | 59 | 60 | 66 | 77 | 80 | 83 | 90 | 91) E_SENT=no ;; esac
    return 1
  fi
  case $STATUS in 3??)
    raise unreachable "$1 answered with a redirect ($STATUS), which the command does not follow. Check Mikud's address."
    return
    ;;
  esac
  return 0
}

# json_settings JSON: the curl settings that send JSON (without secrets: it goes through awk) as the body.
json_settings() {
  js_q=$(printf '%s\001' "$1" | util cfg)
  printf 'header = "Content-Type: application/json"\ndata-binary = "%s"' "$js_q"
}

# qq TEXT: QQ, TEXT with each quote escaped for a curl setting; for bodies of secrets, which hold no backslash.
qq() {
  qq_s=$1 QQ=""
  while :; do
    case $qq_s in
      *\"*)
        QQ="$QQ${qq_s%%\"*}\\\""
        qq_s=${qq_s#*\"}
        ;;
      *) break ;;
    esac
  done
  QQ="$QQ$qq_s"
}

# http_fail WHAT: a refusal: Mikud's {error: {code, message}} (or Better Auth's code), carried in `body`.
http_fail() {
  parse_answer
  hf_body=""
  if [ "$JSON_OK" = 1 ]; then
    hf_body=$(printf '%s' "$BODY" | json compact)
    case $hf_body in "{"* | "["*) ;; *) hf_body="" ;; esac
  fi
  hf_detail=""
  for hf_p in error.message error.code message error_description error; do
    jstr "$hf_p"
    if [ -n "$JV" ]; then
      hf_detail=$JV
      break
    fi
  done
  raise "http_$STATUS" "$1 failed ($STATUS${hf_detail:+: $hf_detail})." "$STATUS" "$hf_body"
}

UA='user-agent = "mikud-connect"'

# Connecting

key_name() {
  kn_raw=${MIKUD_AGENT_NAME:-}
  [ -n "$kn_raw" ] || kn_raw=$HOST
  printf 'skill:%s:%s' "$(printf '%s' "$kn_raw" | util keyname)" "$(rand 4)"
}

grouped() {
  if [ ${#1} -eq 8 ]; then printf '%s-%s' "${1%????}" "${1#????}"; else printf '%s' "$1"; fi
}

# pending_answer PREFIX: RESULT, the members of the answer that shows the attempt.
pending_answer() {
  eval "pa_o=\$${1}origin pa_l=\$${1}link pa_c=\$${1}userCode pa_x=\$${1}codeExpiresAt"
  pa_o=$(esc "$pa_o")
  RESULT="\"status\":\"pending\",\"origin\":\"$pa_o\",\"link\":\"$(esc "$pa_l")\",\"code\":\"$(esc "$(grouped "$pa_c")")\",\"expiresAt\":\"$(iso "$pa_x")\",\"next\":\"mikud connect --wait --url $pa_o\""
}

# connected_answer ORIGIN KEYNAME EXPIRESAT: RESULT.
connected_answer() {
  RESULT="\"status\":\"connected\",\"origin\":\"$(esc "$1")\",\"keyName\":\"$(esc "$2")\",\"expiresAt\":\"$(esc "$3")\""
}

ckn() { if [ "$C_found" = 1 ]; then printf '%s' "$C_keyName"; fi; }

# attempt_warnings PREFIX CONNKEYNAME: WARN, what may be left on Mikud if this attempt were removed now; nothing for a
# completed connect.
attempt_warnings() {
  eval "aw_ph=\$${1}phase aw_pf=\$${1}pollInFlight aw_un=\$${1}uncertain aw_so=\$${1}sessionOpen aw_ks=\$${1}keySaved aw_kn=\$${1}keyName aw_nk=\$${1}noKey"
  WARN=""
  if [ "$aw_ph" = creating_key ]; then
    # The token arrived, so an earlier poll whose answer was lost redeemed nothing: only this session counts. A create
    # that Mikud refused, or that was never sent, made no key.
    if [ "$aw_ks" = 0 ] && [ "$aw_nk" = 0 ] && { [ -z "$2" ] || [ "$2" != "$aw_kn" ]; }; then WARN=key_unknown; fi
    [ "$aw_so" = 0 ] || WARN="${WARN:+$WARN }session_unknown"
  elif [ "$aw_pf" != 0 ] || [ "$aw_un" != 0 ] || [ "$aw_so" != 0 ]; then
    WARN=session_unknown
  fi
}

# remove_attempt PREFIX CONNKEYNAME [SEEN]: removes an attempt, after writing what it may have left on Mikud. Under the
# lock; the file is removed only while it is exactly as this command last read or wrote it (SEEN, PREFIX by default).
# WARN says what that was.
remove_attempt() {
  rec_copy "$1" RA_ "$PEND_FIELDS"
  ra_seen=${3:-$1}
  attempt_warnings RA_ "$2"
  ra_warn=$WARN
  if [ -n "$ra_warn" ]; then
    ra_rows=""
    for ra_w in $ra_warn; do ra_rows="$ra_rows$RA_origin$TAB$RA_keyName$TAB$TAB$ra_w$NL"; done
    add_left "$ra_rows" || return
  fi
  read_pending X_ || return
  if rec_same X_ "$ra_seen" "$PEND_FIELDS"; then remove_file "$PENDING" || return; fi
  WARN=$ra_warn
}

# unknown_fail WARNINGS PREFIX
unknown_fail() {
  eval "uf_o=\$${2}origin uf_k=\$${2}keyName"
  uf_s=""
  case " $1 " in *" session_unknown "*) uf_s=" $SESSION_TEXT" ;; esac
  case " $1 " in *" key_unknown "*)
    raise key_unknown "The connection to $uf_o did not finish, and a key named \"$uf_k\" may exist: delete it in Settings, Agent access.$uf_s"
    return
    ;;
  esac
  raise session_unknown "The connection to $uf_o did not finish, and the command cannot tell what Mikud did. $SESSION_TEXT"
}

# settle: an attempt a lock holder finds in creating_key (P_) belongs to a run that is gone (the lock is held through
# every step of a redeem): it is removed with what it may have left, and kept as the orphan (O_).
settle() {
  O_found=0 SETTLE_WARN=""
  if [ "$P_found" != 1 ] || [ "$P_phase" != creating_key ]; then return 0; fi
  rec_copy P_ O_ "$PEND_FIELDS"
  O_found=1 P_found=0
  remove_attempt O_ "$(ckn)" || return
  SETTLE_WARN=$WARN
}

days_of() {
  DAYS=90
  [ "$OPT_DAYS_SET" = 1 ] || return 0
  case $OPT_DAYS in
    [$DIGIT] | [$DIGIT][$DIGIT] | [$DIGIT][$DIGIT][$DIGIT])
      num "$OPT_DAYS"
      DAYS=$_n
      ;;
    *) DAYS=0 ;;
  esac
  if [ "$DAYS" -lt 1 ] || [ "$DAYS" -gt 365 ]; then
    raise bad_option "--days takes 1 to 365."
    return
  fi
}

cmd_connect() {
  days_of || return
  secure_home 1 || return
  with_lock connect_locked || return
  printf '{%s,"left":%s}\n' "$RESULT" "$(left_now)"
}

# expect_connection: the connection is still exactly C_, as this command read it under the lock; raises "changed".
expect_connection() {
  read_connection Y_ || return
  rec_same Y_ C_ "$CONN_FIELDS" && return 0
  raise changed "The connection changed."
}

connect_locked() {
  read_connection C_ || return
  prune_left || return
  read_pending P_ || return
  cl_found=$P_found cl_found_origin=$P_origin
  settle || return
  cl_origin=""
  if [ -n "$OPT_URL" ]; then
    origin_of "$OPT_URL" || return
    cl_origin=$ORIGIN
  elif [ "$C_found" = 1 ] && [ -n "$C_origin" ]; then
    cl_origin=$C_origin
  elif [ "$cl_found" = 1 ]; then
    cl_origin=$cl_found_origin
  fi
  if [ -z "$cl_origin" ]; then
    raise no_url "No Mikud address is known. Ask the owner for it, then run: mikud connect --url <address>"
    return
  fi
  # The open code again, unless asked for a new one (--replace: the link did not work for the owner).
  if [ "$P_found" = 1 ] && [ "$OPT_REPLACE" = 0 ] && [ "$P_origin" = "$cl_origin" ] && [ "$P_phase" = polling ] &&
    [ "$P_codeExpiresAt" -gt "$(now)" ]; then
    pending_answer P_
    return 0
  fi
  if [ "$C_found" = 1 ] && [ "$OPT_REPLACE" = 0 ]; then
    raise already_connected "Already connected to $C_origin with the key \"$C_keyName\", until $C_expiresAt. To connect again, run: mikud connect --replace"
    return
  fi
  request "$cl_origin" POST /api/auth/device/code "$UA$NL$(json_settings "{\"client_id\":\"$CLIENT_ID\"}")" || return
  if [ "$STATUS" != 200 ]; then
    http_fail "Asking Mikud for a code"
    return
  fi
  parse_answer
  jstr device_code
  cl_dc=$JV
  jstr user_code
  cl_uc=$JV
  jstr verification_uri_complete
  cl_link=$JV
  cl_ucok=0
  case $cl_uc in "" | *[!$UPPER$LOWER$DIGIT-]*) ;; *) [ ${#cl_uc} -lt 4 ] || [ ${#cl_uc} -gt 20 ] || cl_ucok=1 ;; esac
  if ! secret_ok "$cl_dc" || [ "$cl_ucok" = 0 ] || ! plain_ok "$cl_link"; then
    raise unexpected_answer "Mikud answered without a usable code. Nothing was stored."
    return
  fi
  url_parse "$cl_link"
  if [ "$UP" = bad ] || [ "$UP_origin" != "$cl_origin" ]; then
    raise unexpected_answer "Mikud's approval link is not on $cl_origin. Nothing was stored."
    return
  fi
  # A pending attempt is replaced only now, once the new code exists; its link stops being used.
  if [ "$P_found" = 1 ]; then remove_attempt P_ "$(ckn)" || return; fi
  cl_t=$(now)
  jnum interval
  int_of "$JV" 5
  cl_interval=$INT
  jnum expires_in
  int_of "$JV" 600
  N_v=1 N_attemptId=$(rand 8) N_origin=$cl_origin N_deviceCode=$cl_dc N_userCode=$cl_uc N_link=$cl_link
  N_interval=$cl_interval N_nextPollAt=$((cl_t + cl_interval)) N_codeExpiresAt=$((cl_t + INT)) N_days=$DAYS
  N_keyName=$(key_name) N_phase=polling N_pollInFlight=0 N_uncertain=0 N_sessionOpen=0 N_keySaved=0 N_noKey=0
  # Only into the state this command read: no attempt, and the connection it decided on.
  expect_connection || return
  SN_found=0
  save_pending N_ SN_ || return
  pending_answer N_
}

cmd_wait() {
  if [ -n "$OPT_URL" ]; then
    origin_of "$OPT_URL" || return
    WORG=$ORIGIN
  else
    read_pending P_ || return
    WORG=$P_origin
    if [ -z "$WORG" ]; then
      raise not_connected "No connection is being made. Run: mikud connect --url <address>"
      return
    fi
  fi
  cw_until=$(($(date +%s) + WAIT_SECONDS))
  STATE_ID=""
  while :; do
    if ! with_lock wait_step; then
      [ "$E_CODE" = changed ] && continue
      return 1
    fi
    if [ -n "$DONE" ]; then
      printf '{%s,"left":%s}\n' "$DONE" "$(left_now)"
      return 0
    fi
    if [ $(($(date +%s) + STEP_WAIT)) -gt "$cw_until" ]; then
      printf '{"status":"still_waiting","next":"mikud connect --wait --url %s","left":%s}\n' "$(esc "$WORG")" "$(left_now)"
      return 0
    fi
    sleep "$STEP_WAIT"
  done
}

# wait_step: one look at the attempt under the lock: an answer (DONE), the seconds until the next poll (STEP_WAIT), or
# one poll. Every save is conditional on the attempt exactly as this command last read or wrote it (SN_).
wait_step() {
  DONE="" STEP_WAIT=0
  read_connection C_ || return
  prune_left || return
  read_pending P_ || return
  settle || return
  if [ "$O_found" = 1 ] && [ "$O_origin" = "$WORG" ]; then
    if [ -n "$SETTLE_WARN" ]; then
      unknown_fail "$SETTLE_WARN" O_
      return
    fi
    if [ "$C_found" = 1 ] && [ "$C_keyName" = "$O_keyName" ]; then
      connected_answer "$C_origin" "$C_keyName" "$C_expiresAt"
      DONE=$RESULT
      return 0
    fi
  fi
  if [ "$P_found" != 1 ] || [ "$P_origin" != "$WORG" ]; then
    # Another command finished this attempt (a parallel --wait), or it was never made here.
    if [ "$C_found" = 1 ] && [ "$C_origin" = "$WORG" ] && { [ -n "$STATE_ID" ] || [ "$P_found" != 1 ]; }; then
      connected_answer "$C_origin" "$C_keyName" "$C_expiresAt"
      DONE=$RESULT
      return 0
    fi
    if [ -n "$STATE_ID" ]; then
      raise not_connected "The connection to $WORG was cancelled meanwhile."
      return
    fi
    raise not_connected "No connection to $WORG is being made. Run: mikud connect --url $WORG"
    return
  fi
  # Replaced meanwhile (connect --replace): the new attempt has its own link and code.
  if [ -n "$STATE_ID" ] && [ "$P_attemptId" != "$STATE_ID" ]; then
    pending_answer P_
    DONE=$RESULT
    return 0
  fi
  STATE_ID=$P_attemptId
  rec_copy P_ SN_ "$PEND_FIELDS"
  SN_found=1
  ws_t=$(now)
  if [ "$P_codeExpiresAt" -le "$ws_t" ]; then
    remove_attempt P_ "$(ckn)" || return
    if [ -n "$WARN" ]; then
      unknown_fail "$WARN" P_
      return
    fi
    raise expired "The code expired before it was approved. Run: mikud connect --url $WORG"
    return
  fi
  if [ "$P_nextPollAt" -gt "$ws_t" ]; then
    STEP_WAIT=$((P_nextPollAt - ws_t))
    return 0
  fi
  if ! secret_ok "$P_deviceCode"; then
    insecure "$PENDING is damaged. Delete it and connect again."
    return
  fi
  # A mark left set: the run before this one sent a poll and never recorded its answer.
  [ "$P_pollInFlight" = 0 ] || P_uncertain=1
  P_pollInFlight=1
  save_pending P_ SN_ || return
  assert_mine || return
  hook POLL
  qq "{\"grant_type\":\"$DEVICE_GRANT\",\"device_code\":\"$P_deviceCode\",\"client_id\":\"$CLIENT_ID\"}"
  if ! request "$WORG" POST /api/auth/device/token "$UA
header = \"Content-Type: application/json\"
data-binary = \"$QQ\""; then
    QQ=""
    if [ "$E_CODE" = unreachable ]; then
      err_save S
      P_pollInFlight=0
      [ "$E_SENT" = no ] || P_uncertain=1
      P_nextPollAt=$(($(now) + P_interval))
      save_pending P_ SN_ || return
      err_restore S
    fi
    return 1
  fi
  QQ=""
  parse_answer
  TOKEN=""
  if [ "$STATUS" = 200 ]; then
    jstr access_token
    TOKEN=$JV
  fi
  if [ -n "$TOKEN" ]; then
    if ! secret_ok "$TOKEN"; then
      # A session may exist, but this token cannot be sent safely: never used, and reported like a lost answer.
      TOKEN=""
      P_pollInFlight=0 P_uncertain=1 P_nextPollAt=$(($(now) + P_interval))
      save_pending P_ SN_ || return
      raise unexpected_answer "Mikud answered the approval with a token this command cannot use. $SESSION_TEXT"
      return
    fi
    redeem
    ws_rc=$?
    TOKEN=""
    [ "$ws_rc" = 0 ] || return 1
    DONE=$RESULT
    return 0
  fi
  jstr error
  ws_err=$JV
  P_pollInFlight=0
  if [ "$ws_err" = authorization_pending ] || [ "$ws_err" = slow_down ] || [ "$STATUS" = 429 ]; then
    # RFC 8628: 5 seconds longer from now on; a rate-limited poll is the same request to slow down.
    if [ "$ws_err" = slow_down ] || [ "$STATUS" = 429 ]; then P_interval=$((P_interval + 5)); fi
    P_nextPollAt=$(($(now) + P_interval))
    save_pending P_ SN_ || return
    STEP_WAIT=$P_interval
    return 0
  fi
  case $ws_err in
    access_denied | expired_token | invalid_grant)
      remove_attempt P_ "$(ckn)" SN_ || return
      if [ -n "$WARN" ]; then
        unknown_fail "$WARN" P_
        return
      fi
      if [ "$ws_err" = access_denied ]; then
        raise denied "The owner did not approve the connection. Nothing was created."
        return
      fi
      raise expired "The code is no longer valid. Run: mikud connect --url $WORG"
      return
      ;;
  esac
  # A failure after the server may have started: a session may exist.
  if [ "$STATUS" -ge 500 ] || [ "$STATUS" = 200 ]; then P_uncertain=1; fi
  P_nextPollAt=$(($(now) + P_interval))
  save_pending P_ SN_ || return
  http_fail "Waiting for the approval"
}

# end_session ORIGIN: ends the approval's session with its own token. ENDED 1 only when Mikud confirmed it. Sent even
# after the lock was lost: no other command knows this token, and a session left open is the worse outcome.
end_session() {
  ENDED=0
  qq "{\"token\":\"$TOKEN\"}"
  if request "$1" POST /api/auth/revoke-session "$UA
header = \"Authorization: Bearer $TOKEN\"
header = \"Content-Type: application/json\"
data-binary = \"$QQ\""; then
    parse_answer
    jget status
    if [ "$STATUS" = 200 ] && [ "$JK" = t ]; then ENDED=1; fi
  fi
  QQ="" BODY="" JF=""
  return 0
}

# redeem: the approved code gave a session token (TOKEN): record that a key is being created, create it, save the
# connection, end the session, remove the attempt. In this order in every version, all under the lock. SN_ is the
# attempt as last written, C_ the connection as read at the start of this step. RESULT.
redeem() {
  rd_id=$P_attemptId rd_origin=$P_origin rd_name=$P_keyName
  rec_copy SN_ R_ "$PEND_FIELDS"
  R_found=1 R_phase=creating_key R_sessionOpen=1 R_pollInFlight=0
  if ! save_pending R_ SN_; then
    # Nothing is sent before this mark is written: the session ends at once.
    err_save F
    end_session "$rd_origin"
    if [ "$F_code" = changed ]; then
      raise cannot_save "The connection changed while this command ran. Run: mikud status"
      return
    fi
    err_restore F
    return 1
  fi
  hook TOKEN
  rd_ok=1
  if ! create_and_save; then
    rd_ok=0
    err_save F
  fi
  end_session "$rd_origin"
  rd_ended=$ENDED
  # A step from here that fails keeps the attempt, and with it what the attempt may have left on Mikud; it never
  # replaces the answer.
  if [ "$rd_ended" = 1 ]; then
    rec_copy SN_ L_ "$PEND_FIELDS"
    L_found=1 L_sessionOpen=0
    save_pending L_ SN_ || :
  fi
  hook REVOKED
  if read_pending L_; then
    if [ "$L_found" = 1 ] && [ "$L_attemptId" = "$rd_id" ]; then
      # A connection that cannot be read now counts as not saved: the key is then reported, never lost.
      rd_saved=""
      if read_connection K_ && [ "$K_found" = 1 ]; then rd_saved=$K_keyName; fi
      K_key=""
      remove_attempt L_ "$rd_saved" || :
    elif [ "$rd_ended" != 1 ]; then
      add_left "$rd_origin$TAB$rd_name$TAB${TAB}session_unknown" || :
    fi
  fi
  hook DONE
  if [ "$rd_ok" = 0 ]; then
    err_restore F
    [ "$rd_ended" = 1 ] || E_MSG="$E_MSG $SESSION_TEXT"
    return 1
  fi
  connected_answer "$CS_origin" "$CS_keyName" "$CS_expiresAt"
  if [ "$rd_ended" != 1 ]; then
    RESULT="$RESULT,\"warning\":\"Could not confirm that the approval's temporary session ended. End the session \\\"mikud connect (agent approval)\\\" on the Account page in Mikud.\""
  fi
}

# not_saved: with the failure in E_*, records the new key as left on Mikud, or says so in the message.
not_saved() {
  err_save H
  if add_left "$cs_o$TAB$cs_n$TAB$cs_x${TAB}not_saved"; then
    err_restore H
  else
    err_restore H
    E_MSG="$E_MSG The key \"$cs_n\" on $cs_o works until $cs_x: delete it in Settings, Agent access."
  fi
  return 1
}

# no_key: with the failure in E_*, records that Mikud refused the key or the request never left, so no key exists
# (no key_unknown follows).
no_key() {
  err_save H
  rec_copy SN_ NK_ "$PEND_FIELDS"
  NK_found=1 NK_noKey=1
  save_pending NK_ SN_ || :
  err_restore H
  return 1
}

key_unknown_fail() {
  raise key_unknown "Mikud's answer to creating the key was lost, so a key named \"$cs_n\" may exist on $cs_o: delete it in Settings, Agent access. Then run: mikud connect --url $cs_o"
}

# create_and_save: CS_origin, CS_keyName and CS_expiresAt of the saved connection.
create_and_save() {
  cs_o=$R_origin cs_n=$R_keyName cs_x=""
  if ! plain_ok "$cs_n"; then
    insecure "$PENDING is damaged. Delete it and connect again."
    return
  fi
  assert_mine || return
  if ! request "$cs_o" POST /api/auth/api-key/create "$UA
header = \"Authorization: Bearer $TOKEN\"
$(json_settings "{\"name\":\"$cs_n\",\"expiresIn\":$((R_days * 86400))}")"; then
    if [ "$E_CODE" = unreachable ] && [ "$E_SENT" != no ]; then
      key_unknown_fail
      return
    fi
    no_key
    return
  fi
  hook KEY
  if [ "$STATUS" -ge 500 ]; then
    key_unknown_fail
    return
  fi
  if [ "$STATUS" != 200 ]; then
    http_fail "Creating the key"
    no_key
    return
  fi
  parse_answer
  jstr key
  cs_key=$JV
  jstr expiresAt
  cs_x=$JV
  BODY="" JF="" JV=""
  if ! secret_ok "$cs_key" || ! plain_ok "$cs_x" || [ "$(util ms -v s="$cs_x" </dev/null)" = -1 ]; then
    cs_key=""
    key_unknown_fail
    return
  fi
  # From here the key exists with a known name and end date: any failure records it before the answer.
  # Saved only while both files are as this command read them: a parallel disconnect or --replace wins.
  if ! read_pending Q_ || ! read_connection V_; then
    cs_key="" V_key=""
    not_saved
    return
  fi
  if ! rec_same Q_ SN_ "$PEND_FIELDS" || ! rec_same V_ C_ "$CONN_FIELDS"; then
    cs_key="" V_key=""
    raise cannot_save "Another mikud command disconnected or started a new connection while this one waited, so the new key was not saved. Run: mikud status"
    not_saved
    return
  fi
  V_key=""
  W_v=1 W_origin=$cs_o W_key=$cs_key W_keyName=$cs_n W_expiresAt=$cs_x
  cs_key=""
  # The key being replaced stays on Mikud: recorded before the connection that names it is replaced.
  cs_ok=1
  if [ "$C_found" = 1 ] && [ "$C_keyName" != "$cs_n" ]; then
    if add_left "$C_origin$TAB$C_keyName$TAB$C_expiresAt${TAB}replaced"; then hook RECORDED; else cs_ok=0; fi
  fi
  if [ "$cs_ok" = 1 ] && write_connection W_; then
    W_key=""
  else
    W_key=""
    not_saved
    return
  fi
  rec_copy SN_ Q_ "$PEND_FIELDS"
  Q_found=1 Q_keySaved=1
  save_pending Q_ SN_ || :
  hook SAVED
  CS_origin=$cs_o CS_keyName=$cs_n CS_expiresAt=$cs_x
}

# The other commands

cmd_status() {
  if [ "$OPT_CLEAR" = 1 ]; then
    secure_home 1 || return
    with_lock write_left "" || return
  fi
  read_connection C_ || return
  read_pending P_ || return
  if [ "$C_found" = 1 ]; then
    connected_answer "$C_origin" "$C_keyName" "$C_expiresAt"
    st_out=$RESULT
  else
    st_out='"status":"not_connected"'
  fi
  if [ "$P_found" = 1 ]; then
    # An attempt whose key was saved and whose session ended is a finished connect that only lost its last step.
    st_finished=0
    if [ "$P_phase" = creating_key ] && [ "$P_sessionOpen" = 0 ] &&
      { [ "$P_keySaved" != 0 ] || { [ "$C_found" = 1 ] && [ "$C_keyName" = "$P_keyName" ]; }; }; then
      st_finished=1
    fi
    if [ "$st_finished" = 0 ]; then
      attempt_warnings P_ "$(ckn)"
      st_out="$st_out,\"pending\":{\"origin\":\"$(esc "$P_origin")\",\"link\":\"$(esc "$P_link")\",\"code\":\"$(esc "$(grouped "$P_userCode")")\",\"expiresAt\":\"$(iso "$P_codeExpiresAt")\""
      if [ -n "$WARN" ]; then
        st_w=""
        for st_x in $WARN; do st_w="$st_w${st_w:+,}\"$st_x\""; done
        st_out="$st_out,\"warnings\":[$st_w]"
      fi
      st_out="$st_out}"
    fi
  fi
  read_left || return
  st_o="" st_k=""
  if [ "$C_found" = 1 ]; then st_o=$C_origin st_k=$C_keyName; fi
  # An entry for the live key (a run stopped mid-way) is removed under the lock; reported or not, it is never shown.
  if [ -n "$st_o" ] && [ "$(printf '%s\n' "$LEFT" | util left-drop -v o="$st_o" -v k="$st_k")" != "$LEFT" ]; then
    st_left=$LEFT
    with_lock status_prune_locked || :
    LEFT=$st_left
  fi
  C_key=""
  printf '{%s,"left":%s}\n' "$st_out" "$(left_public "$LEFT" "$st_o" "$st_k")"
}

status_prune_locked() {
  read_connection C_ || return
  prune_left
}

cmd_disconnect() {
  secure_home 0 || return
  if [ "$HOME_FOUND" != 1 ]; then
    printf '{"status":"not_connected","left":[]}\n'
    return 0
  fi
  with_lock disconnect_locked || return
  printf '{%s,"left":%s}\n' "$RESULT" "$(left_now)"
}

disconnect_locked() {
  read_connection C_ || return
  prune_left || return
  read_pending P_ || return
  if [ "$P_found" = 1 ]; then remove_attempt P_ "$(ckn)" || return; fi
  if [ "$C_found" != 1 ]; then
    RESULT='"status":"not_connected"'
    return 0
  fi
  # The key stays on Mikud (a key cannot delete itself): recorded before the connection is removed.
  add_left "$C_origin$TAB$C_keyName$TAB$C_expiresAt${TAB}disconnected" || return
  hook RECORDED
  expect_connection || return
  remove_file "$CONNECTION" || return
  RESULT="\"status\":\"disconnected\",\"origin\":\"$(esc "$C_origin")\",\"keyName\":\"$(esc "$C_keyName")\",\"expiresAt\":\"$(esc "$C_expiresAt")\""
  RESULT="$RESULT,\"message\":\"$(esc "Forgot the connection on this computer. The key \"$C_keyName\" still works on $C_origin until $C_expiresAt: delete it in Settings, Agent access, if nothing uses it.")\""
}

# The API

# api_path METHOD RAW: TARGET, the path (and a query on GET) as typed, when it is one of the calls this skill makes.
api_path() {
  ap_v=${2#/}
  ap_part=${ap_v%%\?*}
  ap_query=""
  ap_hasq=0
  if [ "$ap_part" != "$ap_v" ]; then
    ap_hasq=1
    ap_query=${ap_v#*\?}
  fi
  ap_tail=" Use one of the paths in SKILL.md, for example: get 'items?q=login' (percent-encode anything else in a query)."
  case $ap_part in "" | *[!$LOWER$DIGIT/-]* | *//*)
    raise bad_path "The path may hold only lower-case letters, digits, / and -.$ap_tail"
    return
    ;;
  esac
  if [ "$ap_hasq" = 1 ] && [ "$1" != GET ]; then
    raise bad_path "Only get takes a query.$ap_tail"
    return
  fi
  ap_ok=1
  case $ap_query in *[!$UPPER$LOWER$DIGIT$QUERY_CH]*) ap_ok=0 ;; esac
  ap_rest=$ap_query
  while [ "$ap_ok" = 1 ]; do
    case $ap_rest in *%*) ap_rest=${ap_rest#*%} ;; *) break ;; esac
    case $ap_rest in [${DIGIT}ABCDEFabcdef][${DIGIT}ABCDEFabcdef]*) ;; *) ap_ok=0 ;; esac
  done
  if [ "$ap_ok" = 0 ]; then
    raise bad_path "The query holds a character that must be percent-encoded.$ap_tail"
    return
  fi
  # The only calls the command makes on /api/v1: one per MCP tool. $UUID is a pattern.
  # shellcheck disable=SC2254,SC2027
  case "$1 $ap_part" in
    "POST threads/start" | "GET items" | "GET items/"$UUID | "POST items" | "PATCH items/"$UUID | \
      "POST items/"$UUID"/comments" | "POST capture" | "POST items/"$UUID"/threads" | "GET projects" | \
      "PATCH projects/"$UUID | "POST projects/"$UUID"/stage-proposals" | "GET notes" | "GET notes/"$UUID | \
      "POST notes" | "PATCH notes/"$UUID) ;;
    *)
      raise bad_path "$(lower "$1") '$ap_part' is not a call this skill makes.$ap_tail"
      return
      ;;
  esac
  TARGET=$ap_part
  [ "$ap_hasq" = 0 ] || TARGET="$ap_part?$ap_query"
}

body_of() {
  BODYTEXT=""
  if [ "$1" = GET ]; then
    if [ "$OPT_JSON_SET" = 1 ] || [ "$OPT_JSONFILE_SET" = 1 ]; then
      raise bad_json "get takes no body."
      return
    fi
    return 0
  fi
  bo_set=$OPT_JSON_SET
  BODYTEXT=$OPT_JSON
  if [ "$OPT_JSONFILE_SET" = 1 ]; then
    if [ "$bo_set" = 1 ]; then
      raise bad_json "Give either --json or --json-file, not both."
      return
    fi
    if [ -d "$OPT_JSONFILE" ] || ! BODYTEXT=$(cat -- "$OPT_JSONFILE" 2>/dev/null && printf x); then
      raise bad_json "Cannot read $OPT_JSONFILE."
      return
    fi
    BODYTEXT=${BODYTEXT%x}
    bo_set=1
  fi
  if [ "$bo_set" = 0 ]; then
    raise bad_json "$(lower "$1") needs a body: --json '<body>' or --json-file <file>."
    return
  fi
  if ! printf '%s' "$BODYTEXT" | json valid; then
    raise bad_json "The body is not JSON."
    return
  fi
}

label_of() {
  LABEL=""
  if [ "$OPT_AS_SET" = 1 ]; then LABEL=$OPT_AS; else
    LABEL=${MIKUD_AGENT_LABEL:-}
    [ -n "$LABEL" ] || return 0
  fi
  case $LABEL in "" | *[!$UPPER$LOWER$DIGIT$LABEL_CH]*) lo_ok=0 ;; *) lo_ok=1 ;; esac
  if [ "$lo_ok" = 0 ] || [ "${#LABEL}" -gt 60 ]; then
    raise bad_label "The agent label takes 1 to 60 letters, digits, spaces and . _ : - only."
    return
  fi
}

# A key Mikud no longer accepts is forgotten, while it is still the saved one.
forget_locked() {
  read_connection K_ || return
  if rec_same K_ C_ "$CONN_FIELDS"; then remove_file "$CONNECTION"; fi
}

cmd_api() {
  if [ "$POS_COUNT" != 1 ]; then
    raise bad_path "Give one path: mikud $(lower "$1") '<path>'"
    return
  fi
  api_path "$1" "$POS1" || return
  label_of || return
  body_of "$1" || return
  read_connection C_ || return
  if [ "$C_found" != 1 ]; then
    raise not_connected "Not connected to Mikud. Run: mikud connect"
    return
  fi
  if [ -n "$OPT_URL" ]; then
    origin_of "$OPT_URL" || return
    if [ "$ORIGIN" != "$C_origin" ]; then
      raise not_connected "Connected to $C_origin, not to $ORIGIN."
      return
    fi
  fi
  if ! secret_ok "$C_key"; then
    insecure "$CONNECTION is damaged. Delete it and connect again."
    return
  fi
  ca_set="header = \"Authorization: Bearer $C_key\""
  [ -z "$LABEL" ] || ca_set="$ca_set${NL}header = \"X-Mikud-Agent: $LABEL\""
  [ "$1" = GET ] || ca_set="$ca_set$NL$(json_settings "$BODYTEXT")"
  ca_lost="The $1 was sent, but its answer was lost"
  ca_then=": it may still be written. Read the state once before doing anything else, and never send it again blindly."
  if ! request "$C_origin" "$1" "/api/v1/$TARGET" "$ca_set"; then
    ca_set=""
    if [ "$E_CODE" = unreachable ] && [ "$1" != GET ] && [ "$E_SENT" != no ]; then raise outcome_unknown "$ca_lost$ca_then"; fi
    return 1
  fi
  ca_set=""
  if [ "$STATUS" = 401 ]; then
    with_lock forget_locked || :
    raise connection_ended "Mikud no longer accepts this connection's key (it was disconnected in Settings or it expired). Run: mikud connect --url $C_origin"
    return
  fi
  if [ "$1" != GET ]; then
    case $STATUS in 502 | 503 | 504)
      raise outcome_unknown "$ca_lost ($STATUS)$ca_then" "$STATUS"
      return
      ;;
    esac
  fi
  case $STATUS in 2??)
    # Mikud answers {data} (a page also has nextCursor and the like): its fields go next to the HTTP status.
    printf '%s' "$BODY" | json answer -v status="$STATUS"
    return 0
    ;;
  esac
  http_fail "$1 ${TARGET%%\?*}"
}

run_command() {
  case $COMMAND in
    status) cmd_status ;;
    connect)
      need_curl || return
      if [ "$OPT_WAIT" = 1 ]; then cmd_wait; else cmd_connect; fi
      ;;
    disconnect) cmd_disconnect ;;
    get) need_curl && cmd_api GET ;;
    post) need_curl && cmd_api POST ;;
    patch) need_curl && cmd_api PATCH ;;
    *) raise unknown_command "Unknown command \"$COMMAND\". Run: mikud help" ;;
  esac
}

run_command && exit 0
# The files changed under a lock this command no longer held: nothing more was done.
if [ "$E_CODE" = changed ]; then E_CODE=busy E_MSG="Another mikud command changed the connection meanwhile. Run: mikud status"; fi
# What the command left on Mikud travels with every answer about the connection.
case $COMMAND in
  connect | disconnect | status) print_error 1 ;;
  *) print_error 0 ;;
esac
exit 1
