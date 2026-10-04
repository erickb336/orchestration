"""Money in whole cents: never a float."""

from decimal import Decimal, InvalidOperation


class MoneyError(ValueError):
    pass


def to_cents(text):
    """Read an amount such as "12", "12.5" or "-12.50" as whole cents."""
    text = (text or "").strip()
    if not text:
        raise MoneyError("Amount must be a number")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise MoneyError("Amount must be a number")
    if not value.is_finite() or value != value.quantize(Decimal("0.01")):
        raise MoneyError("Amount must be a number")
    return int(value * 100)


def show(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


def shares(cents, people):
    """Split cents among people. The first people in the split take the extra cents."""
    base, extra = divmod(cents, len(people))
    return {p: base + (1 if i < extra else 0) for i, p in enumerate(people)}
