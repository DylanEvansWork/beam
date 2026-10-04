# Simulator benchmark

~6 s of best-case stream per run (payload size varies by tier, shown in the table), 60 Hz display, simulated camera. Goodput = payload bytes / simulated seconds until hash-verified. `ok` = successful trials / trials.

| tier | payload | channel | cam fps | ok | goodput KB/s (mean) | seconds (mean) | RS fixes | rejected frames (tear/blur/bad) |
|---|---|---|---|---|---|---|---|---|
| safe | moderate | 60 | 2/2 | 1.95 | 15.0 | 0 | 8% |
