# Odyhook on Hetzner — what we did and why

This is the conceptual companion to [DEPLOY.md](DEPLOY.md). DEPLOY.md is the *what to type*; this file is the *why*. Read this when you want to understand the deployment, not just follow it.

## What "deploying" actually means

When you run Odyhook on your laptop with `npm run dev`, three things are true:

1. **Your laptop is running the code** — the Node process is alive there.
2. **Your laptop is reachable only to you** — `localhost` is "this same computer".
3. **When you close your laptop, the app dies.**

A deployment changes all three:

1. **Some other always-on computer is running the code** — not your laptop.
2. **That computer is reachable from the public internet** — so Stripe / GitHub / etc. can deliver webhooks to it.
3. **It stays running 24/7** — close your laptop, the app keeps serving.

That "other computer" is the **server** we just rented from Hetzner.

## Where we started, where we are

```
Before:                              After Phase 1:

[Your laptop]                        [Your laptop]
└── Odyhook code                   └── Odyhook code
    runs only here                       (still here, untouched)

                                     [Hetzner server, in Helsinki]  ← NEW
                                     └── Empty Ubuntu Linux box
                                         Reachable at <your-server-ip>
                                         We can log into it via SSH
                                         Costs €4.95/mo
```

We rented an empty computer in a Hetzner data center and proved we can log into it. **No Odyhook code is on that server yet.** That comes in Phase 2.

## Step-by-step, what each thing meant

### "We picked CX23"
We picked the size of the rented computer: **2 CPU cores, 4 GB of memory, 40 GB of disk**. That's the physical capacity of the box. The "23" is just Hetzner's model number; the architecture (x86 Cost-Optimized) means it's an older but cheaper Intel/AMD server.

We didn't pick the bigger sizes (CX33, CX43, ...) because Odyhook's whole stack — Postgres, Redis, Next.js web, worker, Caddy — fits comfortably in 4 GB. Why pay more for headroom we won't use?

We didn't pick the ARM (Ampere) variant — would have been ~20% cheaper — because Hetzner had no ARM capacity available at the time. Functionally identical for our app; it was a coin flip we lost on stock.

### "We picked Helsinki"
We picked which data center the box physically lives in. Closer to your users = lower webhook latency. Helsinki is fine for European traffic. Falkenstein and Nuremberg (Germany) are equivalents.

### "We picked Ubuntu 24.04"
We picked the operating system installed on that empty box. **Ubuntu is a flavor of Linux.** Linux is the default OS for servers because it's free, lightweight, and everything we need (Docker, Node) runs on it natively. **24.04 is the current LTS** — Long Term Support — meaning Ubuntu publishes security patches for it until 2029.

### "We added an SSH key"

**SSH = Secure Shell** = a way to control a remote computer's command line over the encrypted internet. It's like opening a Terminal window, but the Terminal is connected to the Hetzner box instead of your laptop.

Logging into a server needs proof of identity. Two ways to prove "I'm me":

- **Password** — you type a secret, server checks it. **Bad** because internet bots try thousands of passwords per day against every server they can find. Eventually one of them guesses.
- **SSH key** — a pair of cryptographically linked files:
  - **Private key** (`~/.ssh/id_ed25519` on your laptop) — never leaves your laptop. Like a physical house key.
  - **Public key** (`~/.ssh/id_ed25519.pub`) — safe to share. Like the lock that matches that key.

When you gave the public key to Hetzner, the server is saying *"I'll trust anyone who can prove they have the matching private key."* When you `ssh root@<ip>`, your laptop runs a math proof demonstrating it holds the private key — without ever sending it. Bots can't fake this; the math is computationally infeasible to brute-force.

That's why:
- Pasting the public key in Hetzner's UI was safe — it's *meant* to be public.
- The long random `AAAAC3NzaC1lZDI1NTE5...` blob in the middle is what makes it cryptographically secure.
- The email at the end is just a label so you can tell keys apart later.

### "We got an IP: <your-server-ip>"
Every device on the internet has an IP address — a number that uniquely identifies it on the network. Like a street address for houses. This is your server's address on the public internet.

DNS will eventually map a friendly domain name (e.g. `odyhook.yourdomain.com`) to this IP, but the IP is the underlying truth.

### "We SSH'd in"
We opened an encrypted connection from your laptop to your server.

The prompt you saw — `root@odyhook:~#` — tells you:
- `root` — the user you're logged in as (the highest-privilege account on the box)
- `odyhook` — the server's hostname (we named it that)
- `~` — your current directory (the `~` means home directory of the current user, in this case `/root`)
- `#` — the prompt symbol. The specific `#` (vs `$`) indicates you're logged in as root.

**Every command you type at this prompt runs on the Hetzner server, not your laptop.** That's the mental shift: your local terminal is now controlling a computer 3000 km away.

## Where we are now: the architecture map

```
What Odyhook eventually needs:           What we have right now:

[Public internet]                          [Public internet]
        │                                          │
        ▼                                          ▼
    [Caddy]      ← HTTPS proxy               [Empty server]
        │                                      (Ubuntu, nothing else)
        ▼
   [Web (Next)]  ← Dashboard + ingest        Reachable at <your-server-ip>
        │
        ▼
   [Postgres]    ← Database                  Costs €4.95/month
   [Redis]       ← Queue
   [Worker]      ← Delivers events
```

We built the empty box on the right. Now we have to fill it with the four pieces on the left.

## What's left, conceptually

Three big steps:

### 1. Install Docker on the server

Docker is a tool that lets us run multiple programs on one server in isolated boxes called **containers**. Without Docker, installing Postgres + Redis + Node + Caddy on a single Linux box would be a nightmare of conflicting dependencies (different libc versions, different config files, conflicting ports). With Docker, **each program runs in its own clean, predictable container**, and they talk to each other through a small virtual network that Docker manages.

This is why the architecture works on a 4 GB box — Docker is lightweight enough that all four containers + their dependencies + the OS still fit comfortably.

### 2. Get Odyhook's code onto the server

The code lives in your laptop's git repo right now. We'll push it to GitHub (private repo if you want), then on the server we'll `git clone` it down. The server then has a local copy of the source it can build into a container image.

### 3. Tell Docker to run all four containers

We'll write one configuration file (`docker-compose.prod.yml`) that says: *"Run these four containers. Connect them on a private network. Restart them if they crash. Mount these directories so data survives restarts."* Then a single command — `docker compose up -d` — reads that file and brings everything up.

Plus a small DNS step in there (pointing a domain name at the IP so Caddy can issue an HTTPS certificate), and that's the whole rest of the deployment.

## Why this order specifically

We could have picked the deploy artifacts first and provisioned the server last. We didn't, because:

- **Servers can be hard to provision** (Oracle's capacity wall taught us this). Solving that first means the rest is just typing on a known-good machine.
- **Code on no server = useless. Server with no code = useless.** We need both, but the code already existed; we just needed a place to put it.
- **A working SSH connection is the foundation.** If SSH doesn't work, nothing else can. Confirming SSH first is the cheapest possible debugging step.

## What we're deliberately skipping (for now)

Production deployments often involve a bunch of additional infrastructure. We're not doing any of these on purpose:

- **Load balancers, autoscaling, Kubernetes** — for handling massive traffic. Odyhook doesn't need this for the first thousand users.
- **CI/CD pipeline (GitHub Actions auto-deploy)** — convenient, but not necessary on day one. We'll deploy by hand from the server initially. Setting up auto-deploy is a clean fast-follow once the manual flow works.
- **Monitoring / alerting (Sentry, Datadog)** — production hygiene, but not blocking launch. Add it in the first patch release.
- **Off-site backups** — you'll want this within the first week, not on day one. We'll do `pg_dump` to a free S3-compatible store (Backblaze B2 / Cloudflare R2) once the app is live.

We're building the **minimum thing that works in production**, on purpose. Each of those skipped items is a separate chapter that gets added later, when you actually need it.

## TL;DR

You rented a Linux computer. You can SSH into it. It does nothing else yet. Next: install Docker, ship the code, run it.
