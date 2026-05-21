package domain

import (
	"crypto/rand"
	"errors"
	"time"
)

type ID string

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func NewID() (ID, error) {
	var random [10]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	var out [26]byte
	ms := uint64(time.Now().UnixMilli())
	for i := 9; i >= 0; i-- {
		out[i] = crockford[ms&31]
		ms >>= 5
	}
	var buffer uint32
	bits := 0
	index := 10
	for _, b := range random {
		buffer = (buffer << 8) | uint32(b)
		bits += 8
		for bits >= 5 {
			out[index] = crockford[(buffer>>uint(bits-5))&31]
			index++
			bits -= 5
		}
	}
	return ID(out[:]), nil
}

func MustNewID() ID {
	id, err := NewID()
	if err != nil {
		panic(err)
	}
	return id
}

func ValidateID(id ID) error {
	if len(id) != 26 {
		return errors.New("id must be 26 characters")
	}
	for _, ch := range id {
		if !(ch >= '0' && ch <= '9') && !(ch >= 'A' && ch <= 'Z') {
			return errors.New("id must use Crockford base32 uppercase characters")
		}
	}
	return nil
}
