"""Layer 2: the company knowledge base (design 7.2).

One trustworthy record per company, keyed on its CIN or LLPIN, with the source and date of every
fact. Portal startups carry no CIN, so this package decides which company each one is:

  entities.py  the current view of every startup on the two UP portals, joined on its UPLC number
  match.py     exact matching on the registered name, then Splink for the rest, then a person
  llp.py       UP LLPs, found by matching portal LLPs to the LLP sheet of the MCA files we hold
  apply.py     writes the links and the portal facts (with provenance) onto company records
  labels.py    the labelled pairs that measure matching precision
"""
