---
status: accepted
---
# Base URLs are fixed per environment and secrets arrive only as file paths

Configuration selects an environment (`test` or `prod`) and the base URL follows from it; there is no variable to point the client at another host, and every secret is given as the path of a file, never as a value. This keeps a mistaken or hostile environment from redirecting credentials to a third party and keeps secret values out of process listings, shell history and deployment manifests. Tests that need a local server pass the URL and trust anchor through explicit code parameters that are never read from the environment.
