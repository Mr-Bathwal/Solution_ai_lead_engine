"""Enrichment (design 7.3): the details we need to help and reach a company, at the lowest cost.

  caps.py       hard caps from config/caps.json, taken atomically before every paid or quota call
  cache.py      every answer cached, "not found" included (company facts 90 days, contacts 30)
  infyner.py    the MCA data vendor: free lookups and name searches, Rs 5 full profiles
  places.py     UP districts and PIN codes from a registered-office address
  waterfall.py  free sources first; the vendor's free quota next; a paid profile only for the
                month's shortlisted companies, and only while the monthly cap allows
"""
