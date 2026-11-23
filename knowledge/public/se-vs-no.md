---
id: se-vs-no
title: Sweden and Norway at a glance
tags: sweden, norway, country, differences, channels
link: https://developer.stralfors.com/docs
---
The same API serves several countries, but the available channels and the field rules differ. Swedish flows commonly involve digital mailboxes and e-invoice networks, while Norwegian flows commonly involve direct-debit style payment agreements and Norwegian e-invoice formats.

Because rules are per country, always fetch rules and channels for the country of the client you are working with. Each country has its own API user and agreements, so this server keeps one credential profile per country; name the profile when you call a tool, and use `whoami` to see which profiles you can use. Do not assume a field that is optional in one country is optional in another.

This summary is deliberately general; country-specific detail belongs in the vendor documentation or in your own private notes.
