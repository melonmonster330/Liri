// Per-tab auth storage for the Supabase client.
// sessionStorage wins, so each browser tab can stay logged into a different
// account (public vs private testing); localStorage is the fallback +
// write-through so new tabs and iOS app relaunches (which clear
// sessionStorage) still restore the most recent login.
window.liriAuthStorage = {
  getItem: function (k) { try { var s = sessionStorage.getItem(k); return s !== null ? s : localStorage.getItem(k); } catch (e) { return null; } },
  setItem: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} try { localStorage.setItem(k, v); } catch (e) {} },
  removeItem: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} try { localStorage.removeItem(k); } catch (e) {} },
};
