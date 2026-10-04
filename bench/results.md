# Simulator benchmark

30 KB random payload, 60 Hz display, simulated camera. Goodput = payload bytes / simulated seconds until hash-verified. `ok` = successful trials / trials.

| tier | channel | cam fps | ok | goodput KB/s (mean) | seconds (mean) | RS fixes | rejected frames (tear/blur/bad) |
|---|---|---|---|---|---|---|---|
| safe | easy | 60 | 2/2 | 1.95 | 15.0 | 0 | 6% |
| safe | easy | 30 | 2/2 | 1.95 | 15.0 | 0 | 26% |
