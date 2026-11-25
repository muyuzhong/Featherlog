//go:build linux && !android && (amd64 || arm64)

package dock

import "testing"

func TestIsWaylandSession(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{
			name: "wayland without gdk override",
			env:  map[string]string{"WAYLAND_DISPLAY": "wayland-0"},
			want: true,
		},
		{
			name: "x11 session",
			env:  map[string]string{"DISPLAY": ":0"},
			want: false,
		},
		{
			name: "wayland with x11 gdk override",
			env:  map[string]string{"WAYLAND_DISPLAY": "wayland-0", "GDK_BACKEND": "x11"},
			want: false,
		},
		{
			name: "wayland with wayland,x11 gdk backend",
			env:  map[string]string{"WAYLAND_DISPLAY": "wayland-0", "GDK_BACKEND": "wayland,x11"},
			want: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isWaylandSession(func(k string) string { return tc.env[k] })
			if got != tc.want {
				t.Fatalf("isWaylandSession(%v) = %v, want %v", tc.env, got, tc.want)
			}
		})
	}
}
