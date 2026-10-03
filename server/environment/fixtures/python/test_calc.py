# pytest comes from PyPI in the prepare phase; the test runs with no network.
import pytest


def test_add():
    assert 1 + 1 == 2


@pytest.mark.parametrize("n", [1, 2])
def test_positive(n):
    assert n > 0
