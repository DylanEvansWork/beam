# Simulator benchmark

~6 s of best-case stream per run (payload size varies by tier, shown in the table), 60 Hz display, simulated camera. Goodput = payload bytes / simulated seconds until hash-verified. `ok` = successful trials / trials.

| tier | payload | channel | cam fps | ok | goodput KB/s (mean) | seconds (mean) | RS fixes | rejected frames (tear/blur/bad) |
|---|---|---|---|---|---|---|---|---|
| safe | 12 KB | easy | 60 | 1/1 | 1.97 | 6.0 | 0 | 13% |
| safe | 12 KB | moderate | 60 | 1/1 | 1.97 | 6.0 | 0 | 16% |
| safe | 12 KB | moderate | 30 | 1/1 | 1.96 | 6.1 | 4 | 13% |
| safe | 12 KB | harsh | 60 | 1/1 | 1.88 | 6.3 | 0 | 19% |
| safe | 12 KB | harsh | 30 | 1/1 | 1.88 | 6.3 | 8 | 5% |
| balanced | 30 KB | easy | 60 | 1/1 | 9.88 | 3.0 | 0 | 25% |
| balanced | 30 KB | moderate | 60 | 1/1 | 9.88 | 3.0 | 0 | 25% |
| balanced | 30 KB | moderate | 30 | 1/1 | 9.88 | 3.0 | 62 | 7% |
| balanced | 30 KB | harsh | 60 | 1/1 | 9.88 | 3.0 | 4 | 25% |
| balanced | 30 KB | harsh | 30 | 1/1 | 9.88 | 3.0 | 385 | 0% |

| fast | 30 KB | easy | 60 | 1/1 | 31.39 | 0.9 | 190 | 30% |
| fast | 30 KB | moderate | 60 | 1/1 | 31.39 | 0.9 | 770 | 23% |
| fast | 30 KB | moderate | 30 | 1/1 | 31.39 | 0.9 | 27 | 32% |
| fast | 30 KB | harsh | 60 | 0/1 | 0.00 | 20.0 | 116 | 20% |
| fast | 30 KB | harsh | 30 | 0/1 | 0.00 | 20.0 | 72 | 33% |
| max | 30 KB | easy | 60 | 1/1 | 73.24 | 0.4 | 122 | 13% |
| max | 30 KB | moderate | 60 | 1/1 | 76.43 | 0.4 | 715 | 4% |
| max | 30 KB | moderate | 30 | 1/1 | 73.24 | 0.4 | 92 | 0% |
| max | 30 KB | harsh | 60 | 0/1 | 0.00 | 20.0 | 0 | 12% |
| max | 30 KB | harsh | 30 | 0/1 | 0.00 | 20.0 | 0 | 0% |

## Interleave / erasure decoding (balanced, harsh channel)

| setting | ok | mean seconds |
|---|---|---|
| interleave=true erasureConf=0 | 3/3 | 2.9 s |
| interleave=true erasureConf=0.25 | 3/3 | 2.9 s |
| interleave=false erasureConf=0 | 3/3 | 2.9 s |
| interleave=false erasureConf=0.25 | 3/3 | 2.9 s |
