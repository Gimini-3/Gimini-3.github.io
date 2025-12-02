---
title: "[Java Multithreading] Part 1 – Thread.start() vs run() : 자바 코드 + 간단한 흐름 비교"
date: 2025-10-02 15:14:00 +0900
tags: 
  - java
  - concurrency
  - thread
  - start
  - run
  - jvm
thumbnail: ""
---


# [Java Multithreading] Part 1 – Thread.start() vs run() : 자바 코드 + 간단한 흐름 비교

## 0. 왜 `start()` vs `run()`이 헷갈릴까?

스레드 예제를 따라 쓰다 보면 이런 코드를 많이 본다:

```java
Thread t = new Thread(() -> {
    System.out.println("작업: " + Thread.currentThread().getName());
});

// (1)
t.run();

// (2)
t.start();

```

코드만 보면 둘 다 “스레드의 일을 시작한다”는 느낌이라 비슷해 보인다.

하지만 실제로 돌려 보면:

- `run()`을 직접 호출하면 **main 스레드**에서 코드가 실행되고,
- `start()`를 호출하면 **새로운 스레드**가 만들어져 거기서 `run()`이 실행된다.

이 차이가 정확히 **어디서 갈리는지**를 Part 1에서 “자바 코드 기준으로만” 정리해본다.

(JNI, `JVM_StartThread`, `pthread_create` 같은 내부 구현은 Part 2~4에서 깊게 파본다.)

---

## 1. 실험 코드로 보는 `run()` vs `start()`

먼저 가장 기본적인 비교 코드를 보자.

```java
public class ThreadStartVsRun {

    public static void main(String[] args) {
        System.out.println("[main] 시작 스레드 = " + Thread.currentThread().getName());

        Thread t1 = new Thread(() -> {
            System.out.println("[t1.run 호출] 현재 스레드 = " + Thread.currentThread().getName());
        });

        Thread t2 = new Thread(() -> {
            System.out.println("[t2.start 호출] 현재 스레드 = " + Thread.currentThread().getName());
        });

        System.out.println("---- run() 직접 호출 ----");
        t1.run();   // (1)

        System.out.println("---- start() 호출 ----");
        t2.start(); // (2)

        System.out.println("[main] 종료 스레드 = " + Thread.currentThread().getName());
    }
}

```

실행 예시는 보통 이런 식으로 나온다:

```
[main] 시작 스레드 = main
---- run() 직접 호출 ----
[t1.run 호출] 현재 스레드 = main
---- start() 호출 ----
[main] 종료 스레드 = main
[t2.start 호출] 현재 스레드 = Thread-1
```

여기서 바로 핵심이 드러난다.

- `t1.run()` 을 직접 호출하면
    - `run()` 안의 코드가 **main** 스레드에서 실행된다.
- `t2.start()` 를 호출하면
    - JVM이 **새로운 스레드(Thread-1)** 를 만들고,
    - 그 새 스레드에서 `run()` 이 실행된다.

즉:

> run()은 “그냥 메서드 호출”이고,
>
>
> `start()`는 “새 스레드를 만들어 그 스레드가 `run()`을 실행하게 하는 요청”이다.
>

---

## 2. `run()`은 그냥 “일반 메서드 호출”

`run()`을 직접 호출했을 때 무슨 일이 일어나는지, 스레드 관점에서만 보자.

```java
Thread t1 = new Thread(() -> {
    System.out.println("[t1.run 호출] 현재 스레드 = " + Thread.currentThread().getName());
});

t1.run();
```

이건 사실 아래 코드와 아무 차이가 없다:

```java
Runnable r = () -> {
    System.out.println("[t1.run 호출] 현재 스레드 = " + Thread.currentThread().getName());
};

r.run();  // 그냥 메서드 호출
```

호출 스택은 대략 이렇게 된다:

```
(main 스레드)
  main()
    └─ t1.run()  // Thread.run() 메서드 호출
          └─ 람다의 run() 코드 실행
```

- JVM이 새 스레드를 만들지 않는다.
- OS에도 스레드 생성 요청을 보내지 않는다.
- **현재 실행 중인 스레드(main)가 그대로 계속해서 `run()` 코드를 실행**할 뿐이다.

그래서 `run()`을 직접 호출하면,

멀티 스레드 프로그램이 되는 게 아니고,

그냥 “main 스레드가 일을 하나 더 한 것”일 뿐이다.

---

## 3. `start()`는 “새 스레드를 만들어 달라”는 요청

이제 진짜 중요한 부분, `start()` 안쪽을 보자.

```java
public void start() {
    synchronized (this) {
        // zero status corresponds to state "NEW"
        if (holder.threadStatus != 0)
            throw new IllegalThreadStateException();

        start0();
    }
}

```

핵심은 딱 세 가지다.

1. `synchronized (this)`

   → `this`(Thread 객체)의 **모니터 락**을 잡는다.

    - “지금 이 Thread 인스턴스를 start 중이다” 라는 걸 동기화용으로 표시
    - 동시에 두 스레드가 같은 Thread 인스턴스에 대해 `start()`를 호출해

      상태가 꼬이는 걸 막기 위한 락이다.

    - 이 **락 자체는 스레드를 생성하지 않는다.**
        - *“락 획득 = 새 스레드 생성”이 아니다.*
        - 그냥 “이 Thread 객체에 대해 start 작업은 한 번에 하나만” 보장할 뿐이다.
2. `if (holder.threadStatus != 0) ...`

   → 이 Thread가 이미 시작된 적 있는지 검사한다.

    - `threadStatus == 0` → NEW 상태
    - `threadStatus != 0` → 이미 한 번 start되었거나, 종료된 스레드
    - 그래서 `Thread`는 **한 인스턴스를 두 번 이상 `start()` 할 수 없다.**
        - 두 번째부터는 `IllegalThreadStateException`을 던진다.
3. `start0();`

   → 여기서부터는 **자바가 아니라 네이티브 세계**로 넘어간다.

    ```java
    private native void start0();
    
    ```

    - `native` 키워드는 “이 메서드 구현은 C/C++ 같은 네이티브 코드에 있다”는 뜻이다.
    - 자바 쪽에는 **선언만** 있고, 실제 동작은 JVM 내부(C/C++ 코드)에서 한다.
    - 새 스레드를 만들려면 OS API (`pthread_create`, `CreateThread` 등)를 써야 하는데,

      그건 자바 코드로는 직접 호출할 수 없다.

    - 그래서 `start0()`에서 JVM의 C/C++ 코드로 넘어가

      → OS 스레드 생성 API를 호출하고

      → 새로 만들어진 OS 스레드에 “이 자바 Thread의 `run()`을 실행하라”고 연결해준다.


Part 1에서는 여기까지만 본다.

이제부터 나오는 내용( `registerNatives()`, `JVM_StartThread`, `JavaThread`, `os::create_thread`, `pthread_create`, `thread_entry`, `Thread.run()` 호출)은 Part 2~4에서 단계별로 뜯어볼 것이다.

---

## 4. main 스레드 입장에서 본 두 흐름

같은 예제를, 이번에는 “main 스레드 입장”에서 다시 비교해 보자.

### 4-1. `run()` 직접 호출 흐름

```java
Thread t1 = new Thread(() -> {
    System.out.println("[t1.run 호출] 현재 스레드 = " + Thread.currentThread().getName());
});

t1.run();

```

스레드/호출 흐름:

```
[main 스레드]

main()
 ├─ t1.run() 호출
 │    └─ 람다 run() 실행 (여전히 main 스레드)
 └─ 이후 코드 계속 실행

```

- main 스레드는 **중간에 잠시 t1의 일을 대신 실행**했다가,
- 일을 끝내고 다시 main 다음 코드로 돌아간다.
- **스레드는 여전히 1개** (main) 뿐이다.

---

### 4-2. `start()` 호출 흐름

```java
Thread t2 = new Thread(() -> {
    System.out.println("[t2.start 호출] 현재 스레드 = " + Thread.currentThread().getName());
});

t2.start();

```

스레드/호출 흐름(개념도):

```
[main 스레드]                    [새 스레드(Thread-0)]

main()
 ├─ t2.start() 호출
 │    └─ synchronized(this)
 │    └─ 상태 검사(NEW인지)
 │    └─ native start0() 호출
 │         └─ JVM 내부에서 OS에 새 스레드 생성 요청
 │
 └─ 바로 리턴, main의 다음 코드 실행 계속

                               (OS 스케줄러가 Thread-0를 깨움)
                               Thread-0 시작
                               └─ JVM 런타임 엔트리(thread_entry 등)
                                     └─ java.lang.Thread.run()
                                           └─ 람다 run() 코드 실행

```

정리하면:

- **main 스레드**
    - `start()` 호출만 하고 금방 리턴한다.
    - 그 후 본인의 일을 계속한다.
- **새 스레드(Thread-0)**
    - OS가 새로 만든 실행 흐름이다.
    - JVM 런타임을 통해 최종적으로 `Thread.run()` → 우리가 넘긴 `Runnable.run()`을 수행한다.

이제 프로그램 안에는 동시에 **두 개의 스레드(main, Thread-0)** 가 돌아가게 된다.

이게 우리가 흔히 말하는 “멀티 스레드” 상태이다.

---

## 5. 자주 하는 오해 정리

### 오해 1. `run()`을 직접 호출해도 멀티 스레딩이다?

아니다.

- `run()` 직접 호출 = **해당 메서드가 현재 스레드에서 실행**될 뿐이다.
- 별도의 스레드를 만들지 않는다.
- call stack 상으로 보면 그냥 “메서드 하나 더 호출했다”와 완전히 동일하다.

멀티 스레딩이 되려면 **`start()`를 통해 JVM이 OS 스레드를 만들도록** 해야 한다.

---

### 오해 2. `synchronized (this)` 때문에 스레드가 새로 만들어진다?

아니다.

```java
public void start() {
    synchronized (this) {
        ...
        start0();
    }
}

```

- `synchronized(this)` 는 **Thread 객체의 모니터 락**을 잡을 뿐,
- 락을 잡는 행위 자체는 **새 스레드를 생성하지 않는다.**

역할은 오로지:

- 한 Thread 인스턴스에 대해 **여러 스레드가 동시에 `start()`를 호출해도 안전하게 막는 것**
- 즉, 같은 `Thread` 객체에 대해 `start()`가 중복 호출되는 걸 방지하기 위한 동기화.

실제 스레드 생성은 **락 안에서 호출하는 `start0()` 네이티브 메서드**에서 일어난다.

(그리고 그 뒤는 Part 2에서 계속…)

---

### 오해 3. `start()`를 여러 번 호출해도 되지 않나?

안 된다.

```java
Thread t = new Thread(() -> { ... });

t.start(); // OK
t.start(); // IllegalThreadStateException

```

- `threadStatus != 0` 일 때 예외를 던지도록 코드가 짜여 있다.
- 한 번 `start()` 해서 OS 스레드와 매핑되었다가 끝난 `Thread` 객체는

  **“껍데기”만 남는 상태**라고 보면 된다.

- 이 객체는 종료 후 상태(`TERMINATED`)를 확인하거나,

  `getState()`, `getId()` 같은 메서드를 호출하는 데에는 쓰일 수 있지만,

  **다시 시작하는 건 불가능**하다.


새로 스레드를 돌리고 싶다면 **새 `Thread` 인스턴스를 만들어야 한다.**

---

## 6. Part 1 요약 & 다음 글 예고

정리하면:

- `run()` 직접 호출
    - 그냥 **일반 메서드 호출**
    - 현재 스레드(main 등)가 그대로 `run()` 코드를 실행
    - 스레드 수는 늘어나지 않는다.
- `start()` 호출
    - **JVM 네이티브 코드(`start0()`)로 넘어가 OS 스레드 생성 요청**
    - 새 OS 스레드가 만들어지고, 그 스레드에서 최종적으로 `Thread.run()`이 실행
    - 이때부터 진짜 멀티 스레드 환경이 된다.
- `synchronized(this)` 는
    - Thread 객체 단위로 `start()` 호출을 직렬화하기 위한 락일 뿐,
    - 스레드 생성과는 **직접적인 관련이 없다.**

Part 2에서는 지금 살짝 언급만 했던:

- `registerNatives()` / JNI,
- `start0()` 와 `JVM_StartThread`,
- `JavaThread`, `OSThread` 연결,

이 뒤에서 실제로 어떤 코드가 돌아가는지를 “JVM 내부 관점”에서 따라갈 예정이다.